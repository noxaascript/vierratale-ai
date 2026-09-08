// Model catalog. Display names use the opaque VTL branding:
// VTL-<number>.<name>, e.g. VTL-2.7-Flash, VTL-3.3-Pro.
// The real engine tags are mapped to display names here and kept internal.
const MODELS = {
  'gemma3:1b': 'VTL-2.7-Flash',
  'llama3.2:1b': 'VTL-2.9-Core',
  'qwen2.5:1.5b': 'VTL-3.1-Plus',
  'qwen2.5-coder:1.5b': 'VTL-3.3-Pro',
  'qwen3:1.7b': 'VTL-3.5-Reason',
};

// Legacy display names (older `VRTL-*` and `vierratale-<word>`), accepted
// everywhere for backwards compatibility (existing config files may contain
// them). All map onto the current VTL display names.
const LEGACY_DISPLAY = {
  'VRTL-2.fast': 'VTL-2.7-Flash',
  'VRTL-3.small': 'VTL-2.9-Core',
  'VRTL-4.balanced': 'VTL-3.1-Plus',
  'VRTL-4.coder': 'VTL-3.3-Pro',
  'VRTL-5.plus': 'VTL-3.5-Reason',
  'vierratale-fast': 'VTL-2.7-Flash',
  'vierratale-small': 'VTL-2.9-Core',
  'vierratale-balanced': 'VTL-3.1-Plus',
  'vierratale-plus': 'VTL-3.5-Reason',
};

const REVERSE = Object.fromEntries(
  Object.entries(MODELS).map(([k, v]) => [v, k])
);

const LOCAL_MODELS = [
  'VTL-2.7-Flash',
  'VTL-2.9-Core',
  'VTL-3.1-Plus',
  'VTL-3.3-Pro',
  'VTL-3.5-Reason',
];

const CLOUD_MODELS = [];

const TIERS = {
  'VTL-2.7-Flash': 'fast',
  'VTL-2.9-Core': 'small',
  'VTL-3.1-Plus': 'balanced',
  'VTL-3.3-Pro': 'coder',
  'VTL-3.5-Reason': 'reasoning',
};

export const Catalog = {
  // Map any known name (new or legacy) to the current VTL display name.
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
    return 'VTL-2.7-Flash';
  },

  getDefaultCloudModel() {
    return CLOUD_MODELS[0] || '';
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
