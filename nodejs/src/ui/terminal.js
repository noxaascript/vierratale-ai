import { Branding } from './branding.js';

const C = Branding.colors;

export const Terminal = {
  divider(char = '─', length = 50) {
    return `${C.dim}${char.repeat(length)}${C.reset}`;
  },

  printUser(text) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    process.stdout.write('\r\x1b[K');
    console.log();
    console.log(`  ${C.bold}${C.primary}You${C.reset}  ${C.dim}${time}${C.reset}`);
    console.log(`  ${text}`);
    console.log();
  },

  printAIStart() {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    console.log();
    console.log(`  ${C.bold}${C.accent}${Branding.AI_PROMPT}${C.reset}  ${C.dim}${time}${C.reset}`);
    this.curLine = '';
    this._printPrefix();
  },

  _printPrefix() {
    process.stdout.write(`  ${C.accent}│${C.reset} `);
  },

  beginThinking() {
    process.stdout.write(`${C.dim}· · ·${C.reset}`);
  },

  endThinking() {
    process.stdout.write('\r\x1b[2K');
    this._printPrefix();
  },

  printAIChunk(text) {
    this._thinking = this._thinking || false;
    if (this._thinking) {
      this.endThinking();
      this._thinking = false;
    }
    this.curLine = (this.curLine || '') + text;
    process.stdout.write(text);
    this._maybeWrap();
  },

  _maybeWrap() {
    if (this.curLine && this.curLine.length > 100) {
      const words = this.curLine.split(' ');
      if (words.length > 1) {
        const lastWord = words[words.length - 1];
        const rest = this.curLine.slice(0, this.curLine.length - lastWord.length).trimEnd();
        process.stdout.write(`\n${C.accent}│${C.reset} `);
        this.curLine = lastWord;
      }
    }
  },

  printAIEnd() {
    process.stdout.write('\n');
    console.log();
  },

  printError(msg) {
    console.log(`  ${C.error}✖${C.reset} ${msg}`);
  },

  printInfo(msg) {
    console.log(`  ${C.dim}${msg}${C.reset}`);
  },

  printSuccess(msg) {
    console.log(`  ${C.success}✔${C.reset} ${msg}`);
  },

  printWarning(msg) {
    console.log(`  ${C.warning}⚠${C.reset} ${msg}`);
  },

  printSearchResults(results) {
    console.log(`  ${C.warning}Web Search Results${C.reset}`);
    results.forEach((r, i) => {
      console.log(`  ${C.warning}${i + 1}.${C.reset} ${C.bold}${r.title}${C.reset}`);
      console.log(`     ${C.dim}${r.url}${C.reset}`);
      if (r.snippet) console.log(`     ${r.snippet.slice(0, 120)}`);
    });
  },

  async showProgress(steps, work) {
    // Hidden real progress: the work() task runs silently while we paint a
    // fake animated progress line so the install feels alive.
    const frames = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let i = 0;
    const timer = setInterval(() => {
      i++;
      const stage = steps[Math.floor((i / 8) % steps.length)];
      const bar = frames[i % frames.length];
      const fill = '='.repeat(1 + (i % 18)) + '>' + ' '.repeat(18 - (i % 18));
      process.stdout.write(`\r  ${C.accent}${bar}${C.reset} ${C.dim}${stage}${C.reset} [${C.accent}${fill}${C.reset}]`);
    }, 100);
    try {
      await work();
    } finally {
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K');
      console.log(`  ${C.success}✔${C.reset} ${C.dim}Ready${C.reset}`);
      console.log();
    }
  },

  clear() {
    process.stdout.write('\x1b[2J\x1b[H');
  },

  formatMarkdown(text) {
    return text
      .replace(/\*\*(.*?)\*\*/g, `${C.bold}$1${C.reset}`)
      .replace(/`([^`]+)`/g, `${C.accent}\`$1\`${C.reset}`)
      .replace(/```(\w*)\n([\s\S]*?)```/g, `${C.dim}┌─${C.reset}\n$2${C.dim}└─────${C.reset}`);
  },
};
