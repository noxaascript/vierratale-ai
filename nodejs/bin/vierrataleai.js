#!/usr/bin/env node
// VierrataleAI launcher + installer.
//
// Running without flags starts the assistant and auto-detects dependencies:
// if the AI engine (ollama) or the model is missing, they are installed first.
// Running with --install (or --setup / install) additionally creates a global
// "vierrataleai" / "vierratale" command, then starts the assistant.
//
// Installation progress is always the fake animated bar — real engine/model
// output is deliberately hidden so first-run feels quick and clean.
import { run } from '../src/cli.js';
import { Installer } from '../src/installer.js';
import { Config } from '../src/config.js';
import { Branding } from '../src/ui/branding.js';
import { Terminal } from '../src/ui/terminal.js';
import { dirname } from 'path';

const C = Branding.colors;

const INSTALL_STEPS = [
  'Checking the AI engine',
  'Installing dependencies',
  'Downloading the model',
  'Linking the vierrataleai command',
  'Optimizing for this device',
];

const READY_STEPS = ['Checking engine', 'Installing dependencies', 'Downloading model', 'Optimizing'];

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fakeProgress(steps, work) {
  const frames = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  let i = 0;
  const tty = process.stdout.isTTY;
  const timer = setInterval(() => {
    if (!tty) return;
    i++;
    const stage = steps[Math.floor((i / 10) % steps.length)];
    const pct = String(8 + ((i * 7) % 85)).padStart(3, ' ');
    const bar = frames[i % frames.length];
    const fillLen = 1 + (i % 20);
    const fill = '█'.repeat(fillLen) + '░'.repeat(Math.max(0, 20 - fillLen));
    process.stdout.write(`\r  ${C.accent}${bar}${C.reset} ${C.bold}${pct}%${C.reset} ${C.dim}${stage}${C.reset} [${C.accent}${fill}${C.reset}]`);
  }, 110);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    if (tty) process.stdout.write('\r\x1b[2K');
    process.stdout.write(`  ${C.success}✔${C.reset} ${C.bold}${C.dim}100%${C.reset} ${C.dim}Ready${C.reset}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const doInstall = args.includes('--install') || args.includes('--setup') || args.includes('install');
  const quick = args.includes('--version') || args.includes('-v') || args.includes('--help') || args.includes('-h');

  Config.load();

  if (doInstall) {
    console.log(`\n  ${C.bold}${C.primary}${Branding.APP_NAME} ${Branding.VERSION}${C.reset} ${C.dim}— installer${C.reset}\n`);
    const result = await fakeProgress(INSTALL_STEPS, Installer.install());
    if (!result.command) {
      Terminal.printInfo('Could not create a global command; run it via the bin script.');
    } else {
      Terminal.printSuccess(`Engine + model installed; "vierrataleai" (or "vierratale") command available at ${result.commandAlias || result.command}`);
      if (!result.commandOnPath) {
        Terminal.printInfo(`"vierrataleai" won't resolve in a new shell: add ${dirname(result.command)} to PATH, e.g. export PATH="$HOME/.local/bin:$PATH", then reopen the terminal.`);
      }
    }
    console.log();
  } else if (!quick) {
    // Auto-detect: install anything that's missing (engine, model) before starting.
    await fakeProgress(READY_STEPS, Installer.ensure());
    console.log();
  }

  return run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});