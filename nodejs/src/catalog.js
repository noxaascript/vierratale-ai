// Model catalog. Display names use the opaque VTL branding:
// VTL-<number>.<name>, e.g. VTL-2.7-Flash, VTL-4.0.
// The real engine tags are mapped to display names here and kept internal.
const MODELS = {
  'qwen3:0.6b': 'VTL-2.5-Mini',
  'gemma3:1b': 'VTL-2.7-Flash',
  'llama3.2:1b': 'VTL-2.9-Core',
  'llama3.2:3b': 'VTL-3.2-Orbit',
  'qwen2.5:1.5b': 'VTL-3.1-Plus',
  'qwen2.5-coder:1.5b': 'VTL-3.3-Pro',
  'qwen3:1.7b': 'VTL-3.5-Reason',
  'qwen2.5:3b': 'VTL-3.7-Ultra',
  'gemma3:4b': 'VTL-4.7-Gusto',
  'phi4-mini': 'VTL-5.4-Tempo',
  'glm4:9b': 'VTL-5.2-Pinnacle',
  'qwen3:4b': 'VTL-5.9-Sovereign',
  'gpt-4o-mini': 'VTL-4.0',
  'gpt-4o': 'VTL-4.2-Omni',
  'claude-3-5-haiku-20241022': 'VTL-4.5-Plus',
  'claude-sonnet-4-20250514': 'VTL-5.0-Pro',
  'gemini-2.0-flash': 'VTL-6.0-Reason',
  'gemini-1.5-pro': 'VTL-7.0-Omnij',
  'kimi-k2.6:cloud': 'VTL-8.0-Fabric',
  'kimi-k2.7-code:cloud': 'VTL-9.0-Forge',
  'kimi-k3': 'VTL-10.0-Singularity',
};

// Legacy display names (older `VRTL-*` and `vierratale-<word>`), accepted
// everywhere for backwards compatibility (existing config files may contain
// them). All map onto the current VTL display names.
const LEGACY_DISPLAY = {
  'VRTL-1.lite': 'VTL-2.5-Mini',
  'VRTL-2.fast': 'VTL-2.7-Flash',
  'VRTL-3.small': 'VTL-2.9-Core',
  'VRTL-4.balanced': 'VTL-3.1-Plus',
  'VRTL-4.coder': 'VTL-3.3-Pro',
  'VRTL-5.plus': 'VTL-3.5-Reason',
  'VRTL-6.pro': 'VTL-3.7-Ultra',
  'VRTL-7.cloud-mini': 'VTL-4.0',
  'VRTL-8.cloud': 'VTL-4.2-Omni',
  'VRTL-9.cloud-fast': 'VTL-4.5-Plus',
  'VRTL-10.cloud-pro': 'VTL-5.0-Pro',
  'VRTL-11.cloud-lite': 'VTL-6.0-Reason',
  'VRTL-12.cloud-plus': 'VTL-7.0-Omnij',
  'vierratale-lite': 'VTL-2.5-Mini',
  'vierratale-fast': 'VTL-2.7-Flash',
  'vierratale-small': 'VTL-2.9-Core',
  'vierratale-balanced': 'VTL-3.1-Plus',
  'vierratale-plus': 'VTL-3.5-Reason',
  'vierratale-pro': 'VTL-3.7-Ultra',
  'vierratale-cloud-mini': 'VTL-4.0',
  'vierratale-cloud': 'VTL-4.2-Omni',
  'vierratale-cloud-fast': 'VTL-4.5-Plus',
  'vierratale-cloud-pro': 'VTL-5.0-Pro',
  'vierratale-cloud-lite': 'VTL-6.0-Reason',
  'vierratale-cloud-plus': 'VTL-7.0-Omnij',
};

const REVERSE = Object.fromEntries(
  Object.entries(MODELS).map(([k, v]) => [v, k])
);

const LOCAL_MODELS = [
  'VTL-2.5-Mini',
  'VTL-2.7-Flash',
  'VTL-2.9-Core',
  'VTL-3.2-Orbit',
  'VTL-3.1-Plus',
  'VTL-3.3-Pro',
  'VTL-3.5-Reason',
  'VTL-3.7-Ultra',
  'VTL-4.7-Gusto',
  'VTL-5.4-Tempo',
  'VTL-5.2-Pinnacle',
  'VTL-5.9-Sovereign',
];

const CLOUD_MODELS = [
  'VTL-4.0',
  'VTL-4.2-Omni',
  'VTL-4.5-Plus',
  'VTL-5.0-Pro',
  'VTL-6.0-Reason',
  'VTL-7.0-Omnij',
  'VTL-8.0-Fabric',
  'VTL-9.0-Forge',
  'VTL-10.0-Singularity',
];

const TIERS = {
  'VTL-2.5-Mini': 'minimal',
  'VTL-2.7-Flash': 'fast',
  'VTL-2.9-Core': 'small',
  'VTL-3.2-Orbit': 'small',
  'VTL-3.1-Plus': 'balanced',
  'VTL-3.3-Pro': 'coder',
  'VTL-3.5-Reason': 'reasoning',
  'VTL-3.7-Ultra': 'ultra',
  'VTL-4.7-Gusto': 'balanced',
  'VTL-5.4-Tempo': 'balanced',
  'VTL-5.2-Pinnacle': 'pro',
  'VTL-5.9-Sovereign': 'pro',
  'VTL-4.0': 'cloud-mini',
  'VTL-4.2-Omni': 'cloud',
  'VTL-4.5-Plus': 'cloud-fast',
  'VTL-5.0-Pro': 'cloud-pro',
  'VTL-6.0-Reason': 'cloud-lite',
  'VTL-7.0-Omnij': 'cloud-plus',
  'VTL-8.0-Fabric': 'cloud-fabric',
  'VTL-9.0-Forge': 'cloud-forge',
  'VTL-10.0-Singularity': 'cloud-singularity',
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
    return 'VTL-4.0';
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
