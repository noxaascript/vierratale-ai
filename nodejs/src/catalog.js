// Model catalog. Display names use the countable VRTL branding:
// VRTL-<number>.<word>, e.g. VRTL-2.fast, VRTL-7.cloud-mini.
const MODELS = {
  'qwen3:0.6b': 'VRTL-1.lite',
  'gemma3:1b': 'VRTL-2.fast',
  'llama3.2:1b': 'VRTL-3.small',
  'qwen2.5:1.5b': 'VRTL-4.balanced',
  'qwen2.5-coder:1.5b': 'VRTL-4.coder',
  'qwen3:1.7b': 'VRTL-5.plus',
  'qwen2.5:3b': 'VRTL-6.pro',
  'gpt-4o-mini': 'VRTL-7.cloud-mini',
  'gpt-4o': 'VRTL-8.cloud',
  'claude-3-5-haiku-20241022': 'VRTL-9.cloud-fast',
  'claude-sonnet-4-20250514': 'VRTL-10.cloud-pro',
  'gemini-2.0-flash': 'VRTL-11.cloud-lite',
  'gemini-1.5-pro': 'VRTL-12.cloud-plus',
};

// Older `vierratale-<word>` names, accepted everywhere for backwards
// compatibility (existing config files may still contain them).
const LEGACY_DISPLAY = {
  'vierratale-lite': 'VRTL-1.lite',
  'vierratale-fast': 'VRTL-2.fast',
  'vierratale-small': 'VRTL-3.small',
  'vierratale-balanced': 'VRTL-4.balanced',
  'vierratale-plus': 'VRTL-5.plus',
  'vierratale-pro': 'VRTL-6.pro',
  'vierratale-cloud-mini': 'VRTL-7.cloud-mini',
  'vierratale-cloud': 'VRTL-8.cloud',
  'vierratale-cloud-fast': 'VRTL-9.cloud-fast',
  'vierratale-cloud-pro': 'VRTL-10.cloud-pro',
  'vierratale-cloud-lite': 'VRTL-11.cloud-lite',
  'vierratale-cloud-plus': 'VRTL-12.cloud-plus',
};

const REVERSE = Object.fromEntries(
  Object.entries(MODELS).map(([k, v]) => [v, k])
);

const LOCAL_MODELS = [
  'VRTL-1.lite',
  'VRTL-2.fast',
  'VRTL-3.small',
  'VRTL-4.balanced',
  'VRTL-4.coder',
  'VRTL-5.plus',
  'VRTL-6.pro',
];

const CLOUD_MODELS = [
  'VRTL-7.cloud-mini',
  'VRTL-8.cloud',
  'VRTL-9.cloud-fast',
  'VRTL-10.cloud-pro',
  'VRTL-11.cloud-lite',
  'VRTL-12.cloud-plus',
];

const TIERS = {
  'VRTL-1.lite': 'minimal',
  'VRTL-2.fast': 'fast',
  'VRTL-3.small': 'small',
  'VRTL-4.balanced': 'balanced',
  'VRTL-4.coder': 'coder',
  'VRTL-5.plus': 'plus',
  'VRTL-6.pro': 'professional',
  'VRTL-7.cloud-mini': 'cloud-mini',
  'VRTL-8.cloud': 'cloud',
  'VRTL-9.cloud-fast': 'cloud-fast',
  'VRTL-10.cloud-pro': 'cloud-pro',
  'VRTL-11.cloud-lite': 'cloud-lite',
  'VRTL-12.cloud-plus': 'cloud-plus',
};

export const Catalog = {
  // Map any known name (new or legacy) to the current VRTL display name.
  normalize(displayName) {
    return LEGACY_DISPLAY[displayName] || displayName;
  },

  getRealModel(displayName) {
    return REVERSE[this.normalize(displayName)] || displayName;
  },

  getDisplayName(realModel) {
    return MODELS[realModel] || realModel;
  },

  getAllModels() {
    return { ...MODELS };
  },

  getLocalModels() {
    return [...LOCAL_MODELS];
  },

  getCloudModels() {
    return [...CLOUD_MODELS];
  },

  getDefaultModel() {
    return 'VRTL-2.fast';
  },

  getDefaultCloudModel() {
    return 'VRTL-7.cloud-mini';
  },

  isLocalModel(displayName) {
    return LOCAL_MODELS.includes(this.normalize(displayName));
  },

  isCloudModel(displayName) {
    return CLOUD_MODELS.includes(this.normalize(displayName));
  },

  getVendorForCloudModel(displayName) {
    const real = REVERSE[this.normalize(displayName)];
    if (real && real.startsWith('claude-')) return 'anthropic';
    if (real && real.startsWith('gemini-')) return 'gemini';
    if (real && real.startsWith('gpt-')) return 'openai';
    return 'openai';
  },

  getModelInfo(displayName) {
    const name = this.normalize(displayName);
    const real = REVERSE[name];
    if (!real) return null;
    const isLocal = LOCAL_MODELS.includes(name);
    const isCloud = CLOUD_MODELS.includes(name);
    return {
      displayName,
      realModel: real,
      isLocal,
      isCloud,
      tier: TIERS[name] || 'unknown',
    };
  },
};