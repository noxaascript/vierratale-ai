import { BaseProvider } from './base.js';
import { Catalog } from '../catalog.js';
import { Config } from '../config.js';

export class OpenAIProvider extends BaseProvider {
  constructor() {
    super('openai');
  }

  get displayName() {
    return 'Nebula';
  }

  async isAvailable() {
    const key = Config.get('openaiApiKey');
    if (!key) return false;
    try {
      const resp = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async listModels() {
    const key = Config.get('openaiApiKey');
    if (!key) return [];
    try {
      const resp = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.data || [])
        .filter((m) => m.id.startsWith('gpt-'))
        .map((m) => ({
          realName: m.id,
          displayName: Catalog.getDisplayName(m.id),
        }));
    } catch {
      return [];
    }
  }

  // If the configured model is a local (ollama) model, use a cloud default so
  // we never send a qwen model name to the OpenAI API.
  _resolveModel(options) {
    const requested = options.model || Config.get('model');
    if (Catalog.isLocalModel(requested) || !Catalog.isCloudModel(requested)) {
      return 'gpt-4o-mini';
    }
    return Catalog.getRealModel(requested);
  }

  async *stream(messages, options = {}) {
    const key = Config.get('openaiApiKey');
    if (!key) throw new Error('[ERR-0004] Cloud API key not configured. Add it to the config and try again.');

    const model = this._resolveModel(options);
    const systemPrompt = options.systemPrompt || '';

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of messages) {
      apiMessages.push({ role: msg.role, content: msg.content });
    }

    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 240000);

    let resp;
    try {
      resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: apiMessages,
          stream: true,
          temperature: options.temperature || Config.get('temperature'),
          max_tokens: options.maxTokens || Config.get('maxTokens'),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('[ERR-0001] Could not reach the API (no response within 60s). Check your network connection.');
      }
      throw new Error('[ERR-0001] Could not reach the API (no response). Check your network connection.');
    } finally {
      clearTimeout(connectTimer);
    }

    if (!resp.ok) {
      throw new Error('[ERR-0003] The cloud provider returned HTTP ' + resp.status + '. Check your API key in config.');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idle = null;
    const settle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), 240000);
    };
    settle();
    try {
      while (true) {
        let value, done;
        try {
          ({ done, value } = await reader.read());
        } catch (err) {
          if (err.name === 'AbortError') {
            throw new Error('[ERR-0001] Lost the connection to the cloud API (no data for 60s).');
          }
          throw err;
        }
        if (done) break;
        settle();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') return;
          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content;
            if (content) yield content;
          } catch {}
        }
      }
    } finally {
      if (idle) clearTimeout(idle);
    }
  }
}
