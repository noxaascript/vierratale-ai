import { BaseProvider } from './base.js';
import { Catalog } from '../catalog.js';
import { Config } from '../config.js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiProvider extends BaseProvider {
  constructor() {
    super('gemini');
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
    return real.startsWith('gemini-') ? real : 'gemini-2.0-flash';
  }

  async isAvailable() {
    const key = Config.get('geminiApiKey');
    return Boolean(key);
  }

  async listModels() {
    const key = Config.get('geminiApiKey');
    if (!key) return [];
    const models = Object.keys(Catalog.getAllModels()).filter((m) => m.startsWith('gemini-'));
    return models.map((real) => ({
      realName: real,
      displayName: Catalog.getDisplayName(real),
    }));
  }

  async *stream(messages, options = {}) {
    const key = Config.get('geminiApiKey');
    if (!key) throw new Error('[ERR-0004] Cloud API key not configured. Add it to the config and try again.');

    const model = this._resolveModel(options);
    const systemPrompt = options.systemPrompt || '';

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    if (systemPrompt) {
      contents.unshift({ role: 'user', parts: [{ text: `System: ${systemPrompt}` }] });
    }

    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 240000);

    let resp;
    try {
      resp = await fetch(
        `${GEMINI_URL}/${model}:streamGenerateContent?key=${key}&alt=sse`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: {
              temperature: options.temperature || Config.get('temperature'),
              maxOutputTokens: options.maxTokens || Config.get('maxTokens'),
            },
          }),
          signal: controller.signal,
        }
      );
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
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) yield text;
          } catch {}
        }
      }
    } finally {
      if (idle) clearTimeout(idle);
    }
  }
}
