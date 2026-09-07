import { BaseProvider } from './base.js';
import { Catalog } from '../catalog.js';
import { Config } from '../config.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export class AnthropicProvider extends BaseProvider {
  constructor() {
    super('anthropic');
  }

  get displayName() {
    return 'Nebula';
  }

  _resolveModel(options) {
    const requested = options.model || Config.get('model');
    if (Catalog.isLocalModel(requested) || !Catalog.isCloudModel(requested)) {
      return Catalog.getRealModel(Catalog.getDefaultCloudModel());
    }
    const real = Catalog.getRealModel(requested);
    return real.startsWith('claude-') ? real : 'claude-3-5-haiku-20241022';
  }

  async isAvailable() {
    const key = Config.get('anthropicApiKey');
    return Boolean(key);
  }

  async listModels() {
    const key = Config.get('anthropicApiKey');
    if (!key) return [];
    const models = Object.keys(Catalog.getAllModels()).filter((m) => m.startsWith('claude-'));
    return models.map((real) => ({
      realName: real,
      displayName: Catalog.getDisplayName(real),
    }));
  }

  async *stream(messages, options = {}) {
    const key = Config.get('anthropicApiKey');
    if (!key) throw new Error('[ERR-0004] Cloud API key not configured. Add it to the config and try again.');

    const model = this._resolveModel(options);
    const systemPrompt = options.systemPrompt || '';

    const system = [];
    if (systemPrompt) system.push({ type: 'text', text: systemPrompt });
    const apiMessages = messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 240000);

    let resp;
    try {
      resp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system: system.length ? system : undefined,
          messages: apiMessages,
          max_tokens: options.maxTokens || Config.get('maxTokens'),
          stream: true,
          temperature: options.temperature || Config.get('temperature'),
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
          try {
            const json = JSON.parse(data);
            if (json.type === 'content_block_delta' && json.delta?.text) {
              yield json.delta.text;
            }
          } catch {}
        }
      }
    } finally {
      if (idle) clearTimeout(idle);
    }
  }
}
