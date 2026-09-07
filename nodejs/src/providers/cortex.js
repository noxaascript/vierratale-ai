import { BaseProvider } from './base.js';
import { Catalog } from '../catalog.js';
import { Config } from '../config.js';

// Keep the prompt a local engine must re-process per call bounded: the
// system prompt plus the most recent messages. Sending the whole growing
// history makes prompt-processing time unbounded on slow hardware.
const MAX_CONTEXT_MESSAGES = 12;

function buildEngineMessages(systemPrompt, messages) {
  const engineMessages = [];
  if (systemPrompt) {
    engineMessages.push({ role: 'system', content: systemPrompt });
  }
  for (const msg of messages) {
    engineMessages.push({ role: msg.role, content: msg.content });
  }
  if (engineMessages.length > MAX_CONTEXT_MESSAGES) {
    return [engineMessages[0], ...engineMessages.slice(-(MAX_CONTEXT_MESSAGES - 1))];
  }
  return engineMessages;
}

export class CortexProvider extends BaseProvider {
  constructor() {
    super('cortex');
    this.host = Config.get('engineHost');
  }

  get displayName() {
    return 'Cortex';
  }

  get isLocal() {
    return true;
  }

  async isAvailable() {
    try {
      const resp = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async listModels() {
    try {
      const resp = await fetch(`${this.host}/api/tags`);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.models || []).map((m) => ({
        realName: m.name,
        displayName: Catalog.getDisplayName(m.name),
        size: m.size,
      }));
    } catch {
      return [];
    }
  }

  async *stream(messages, options = {}) {
    const model = Catalog.getRealModel(options.model || Config.get('model'));
    const engineMessages = buildEngineMessages(options.systemPrompt || '', messages);

    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 600000);

    let resp;
    try {
      resp = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: engineMessages,
          stream: true,
          keep_alive: Config.get('keepAlive'),
          options: {
            num_ctx: Config.get('numCtx'),
            num_predict: options.maxTokens ?? Config.get('maxTokens'),
            temperature: options.temperature || Config.get('temperature'),
            num_thread: Config.get('numThreads'),
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('[ERR-0001] Could not reach the engine (no response within 600s). Make sure the local engine is running.');
      }
      throw new Error('[ERR-0001] Could not reach the engine (no response). Make sure the local engine is running.');
    } finally {
      clearTimeout(connectTimer);
    }

    if (!resp.ok) {
      throw new Error(await describeEngineError(resp, model));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idle = null;
    const settle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), 420000);
    };
    settle();
    try {
      while (true) {
        let value, done;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          if (err.name === 'AbortError') {
            throw new Error('[ERR-0001] Lost the connection to the engine (no data for 420s).');
          }
          throw err;
        }
        if (done) break;
        settle();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.message?.content) {
              yield json.message.content;
            }
            if (json.done) return;
          } catch {}
        }
      }
    } finally {
      if (idle) clearTimeout(idle);
    }
  }

  // Non-streaming completion (used by the tool-planning step). Reads the
  // streamed reply incrementally: on a slow engine a full answer can take
  // minutes, so only a connection with no response for 180s (or an idle
  // stream for 120s) counts as a failure - not a slowly progressing one.
  async complete(messages, options = {}) {
    const model = Catalog.getRealModel(options.model || Config.get('model'));
    const engineMessages = buildEngineMessages(options.systemPrompt || '', messages);

    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 600000);

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let resp;
    try {
      resp = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: engineMessages,
          stream: true,
          keep_alive: Config.get('keepAlive'),
          options: {
            num_ctx: Config.get('numCtx'),
            num_predict: options.maxTokens ?? Config.get('maxTokens'),
            temperature: options.temperature || Config.get('temperature'),
            num_thread: Config.get('numThreads'),
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('[ERR-0001] Could not complete the request (no response within 600s).');
      }
      throw new Error('[ERR-0001] Could not reach the engine (no response). Make sure the local engine is running.');
    } finally {
      clearTimeout(connectTimer);
    }

    if (!resp.ok) {
      throw new Error(await describeEngineError(resp, model));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idle = null;
    const settle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), 120000);
    };
    settle();
    let output = '';
    try {
      while (true) {
        let value, done;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          if (err.name === 'AbortError') {
            throw new Error('[ERR-0001] Lost the connection to the engine (no data for 420s).');
          }
          throw err;
        }
        if (done) break;
        settle();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.message?.content) {
              output += json.message.content;
            }
            if (json.done) {
              buffer = '';
              break;
            }
          } catch {}
        }
      }
    } finally {
      if (idle) clearTimeout(idle);
      controller.abort();
    }
    return output;
  }

  async warmup() {
    // Fire-and-forget: ask the engine to load the model eagerly, then abort as
    // soon as generation starts. The engine runs with a single slot, so an
    // in-flight non-streaming 'hi' would block the first real request.
    const model = Catalog.getRealModel(Config.get('model'));
    const controller = new AbortController();
    fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        keep_alive: Config.get('keepAlive'),
        options: { num_ctx: Config.get('numCtx') },
      }),
      signal: controller.signal,
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) return;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (let i = 0; i < 100; i++) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              if (JSON.parse(line).message?.content) {
                controller.abort();
                return;
              }
            } catch {}
          }
        }
      })
      .catch(() => {});
  }
}

// Build a user-actionable message when the engine rejects a request (e.g. a
// cloud model name posted to a local engine -> 404 "model not found"). The
// engine host is deliberately kept out of the message; errors carry codes.
async function describeEngineError(resp, model) {
  if (/not found|does not exist|model.*missing/i.test(String(resp.statusText))) {
    return `[ERR-0002] Model "${model}" is not installed on the engine. If you picked a cloud model, use /model VRTL-6.pro or /provider openai.`;
  }
  let body = '';
  try {
    body = (await resp.text()).slice(0, 300);
  } catch {}
  if (/not found|does not exist|model.*missing/i.test(body)) {
    return `[ERR-0002] Model "${model}" is not installed on the engine. If you picked a cloud model, use /model VRTL-6.pro or /provider openai.`;
  }
  return `[ERR-0003] The engine returned HTTP ${resp.status}. Check the engine status or run /model VRTL-2.fast.`;
}
