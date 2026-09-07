import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Catalog } from './catalog.js';

function configPaths() {
  const dir = process.env.VIERRATALE_CONFIG_DIR
    ? join(process.env.VIERRATALE_CONFIG_DIR)
    : join(homedir(), '.config', 'vierrataleai');
  return { dir, file: join(dir, 'config.json') };
}

const DEFAULTS = {
  provider: 'auto',
  model: 'VTL-2.7-Flash',
  engineHost: 'http://127.0.0.1:11434',
  numCtx: 2048,
  temperature: 0.7,
  maxTokens: 4096,
  keepAlive: '5m',
  numThreads: 8,
  commandTimeoutMs: 60000,
  planTimeoutMs: 45000,
  downloadDir: join(homedir(), 'Downloads'),
};

function loadConfigFile() {
  try {
    const { file } = configPaths();
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {}
  return {};
}

function getEnv(key, fallback) {
  return process.env[key] || fallback;
}

export const Config = {
  _config: null,

  load() {
    const file = loadConfigFile();
    // Migrate legacy 'cortexHost' key to 'engineHost' if present.
    const engineHost = file.engineHost || file.cortexHost || DEFAULTS.engineHost;
    this._config = {
      provider: getEnv('VIERRATALE_PROVIDER', file.provider || DEFAULTS.provider),
      model: getEnv('VIERRATALE_MODEL', file.model || DEFAULTS.model),
      engineHost: getEnv('VIERRATALE_ENGINE_HOST', engineHost),
      numCtx: parseInt(getEnv('VIERRATALE_NUM_CTX', String(file.numCtx ?? DEFAULTS.numCtx))),
      temperature: parseFloat(getEnv('VIERRATALE_TEMPERATURE', String(file.temperature ?? DEFAULTS.temperature))),
      maxTokens: parseInt(getEnv('VIERRATALE_MAX_TOKENS', String(file.maxTokens ?? DEFAULTS.maxTokens))),
      keepAlive: getEnv('VIERRATALE_KEEP_ALIVE', file.keepAlive ?? DEFAULTS.keepAlive),
      numThreads: parseInt(getEnv('VIERRATALE_NUM_THREADS', String(file.numThreads ?? DEFAULTS.numThreads))),
      openaiApiKey: getEnv('OPENAI_API_KEY', file.openaiApiKey || ''),
      anthropicApiKey: getEnv('ANTHROPIC_API_KEY', file.anthropicApiKey || ''),
      geminiApiKey: getEnv('GEMINI_API_KEY', file.geminiApiKey || ''),
      systemPrompt: file.systemPrompt || '',
      providerModels: file.providerModels || {},
      downloadDir: getEnv('VIERRATALE_DOWNLOAD_DIR', file.downloadDir ?? DEFAULTS.downloadDir),
      commandTimeoutMs: parseInt(getEnv('VIERRATALE_COMMAND_TIMEOUT_MS', String(file.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs))),
      planTimeoutMs: parseInt(getEnv('VIERRATALE_PLAN_TIMEOUT_MS', String(file.planTimeoutMs ?? DEFAULTS.planTimeoutMs))),
    };
    return this._config;
  },

  get(key) {
    if (!this._config) this.load();
    return this._config[key];
  },

  getAll() {
    if (!this._config) this.load();
    return { ...this._config };
  },

  getProviderModel(provider) {
    if (!this._config) this.load();
    return this._config.providerModels?.[provider] || null;
  },

  setProviderModel(provider, model) {
    if (!this._config) this.load();
    this._config.providerModels = this._config.providerModels || {};
    this._config.providerModels[provider] = model;
    this.save();
  },

  getEffectiveModel(provider) {
    const raw = this.getProviderModel(provider) || this.get('model');
    return Catalog.normalize(raw);
  },

  save(overrides = {}) {
    const { dir, file } = configPaths();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const current = this._config || DEFAULTS;
    const merged = { ...current, ...overrides };
    writeFileSync(file, JSON.stringify(merged, null, 2));
    this._config = merged;
  },

  getConfigDir() {
    return configPaths().dir;
  },
};
