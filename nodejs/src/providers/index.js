import { CortexProvider } from './cortex.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { Config } from '../config.js';

let providers = {};

function getProviders() {
  if (Object.keys(providers).length === 0) {
    providers = {
      cortex: new CortexProvider(),
      openai: new OpenAIProvider(),
      anthropic: new AnthropicProvider(),
      gemini: new GeminiProvider(),
    };
  }
  return providers;
}

export const ProviderFactory = {
  async autoDetect() {
    const ps = getProviders();
    const requested = Config.get('provider');

    if (requested !== 'auto' && ps[requested]) {
      if (await ps[requested].isAvailable()) return ps[requested];
    }

    for (const name of ['cortex', 'openai', 'anthropic', 'gemini']) {
      if (await ps[name].isAvailable()) return ps[name];
    }

    return null;
  },

  create(name) {
    const ps = getProviders();
    return ps[name] || null;
  },

  getAvailable() {
    return getProviders();
  },
};
