import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Branding } from './branding.js';
import { Terminal } from './terminal.js';
import { Config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadSystemPrompt() {
  const custom = Config.get('systemPrompt');
  if (custom) return custom;
  try {
    const jsonPath = join(__dirname, '..', 'prompts', 'system.json');
    const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    return data.system;
  } catch {
    return `You are ${Branding.APP_NAME}, an intelligent AI assistant. Be helpful, concise, and accurate.`;
  }
}

export function showBanner(providerName, model, providerDisplayName) {
  const C = Branding.colors;
  const width = 44;
  const border = `  ╔${'═'.repeat(width)}╗`;
  const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = (s) => s + ' '.repeat(Math.max(1, width - visible(s).length));

  console.log();
  console.log(`${C.primary}${Branding.BANNER}${C.reset}`);
  console.log(`  ${C.bold}${C.accent}▸ Vierratale AI ▸ ${providerDisplayName || 'Cortex'} Engine${C.reset}`);
  console.log();
  console.log(border);
  console.log(`  ║${pad('  ' + C.bold + C.primary + 'Model' + C.reset)}║`);
  console.log(`  ║${pad('   ' + C.accent + model + C.reset)}║`);
  console.log(`  ║${pad('  ' + C.bold + C.primary + 'Engine' + C.reset)}║`);
  console.log(`  ║${pad('   ' + C.accent + (providerDisplayName || 'Cortex') + C.reset)}║`);
  console.log(`  ╚${'═'.repeat(width)}╝`);
  console.log();
  console.log(`  ${C.dim}Type /help for commands · /quit to exit${C.reset}`);
  console.log();
}
