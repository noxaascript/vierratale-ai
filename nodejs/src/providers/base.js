export class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  get displayName() {
    return 'Cortex';
  }

  get isLocal() {
    return false;
  }

  async *stream(messages, options = {}) {
    throw new Error('stream() must be implemented');
  }

  // Non-streaming convenience: collects the stream. Providers may override
  // with a proper single-shot request (see CortexProvider).
  async complete(messages, options = {}) {
    let out = '';
    for await (const chunk of this.stream(messages, options)) {
      out += chunk;
    }
    return out;
  }

  async listModels() {
    throw new Error('listModels() must be implemented');
  }

  async isAvailable() {
    return false;
  }
}
