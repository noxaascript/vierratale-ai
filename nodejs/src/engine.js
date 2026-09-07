import { execSync, exec } from 'child_process';
import { existsSync } from 'fs';
import { Catalog } from './catalog.js';
import { Config } from './config.js';

function runSilent(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { stdio: 'ignore' }, (err) => resolve(!err));
  });
}

function isEngineRunning(host) {
  return fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
}

function isEngineInstalled() {
  try {
    execSync('which ollama 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {}
  const paths = ['/usr/local/bin/ollama', '/usr/bin/ollama'];
  return paths.some((p) => existsSync(p));
}

async function installEngine() {
  await runSilent('curl -fsSL https://ollama.com/install.sh | sh');
  return isEngineInstalled();
}

async function getInstalledModels(host) {
  try {
    const resp = await fetch(`${host}/api/tags`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

async function pullModel(host, model) {
  try {
    const resp = await fetch(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false }),
      signal: AbortSignal.timeout(600000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function familyOf(model) {
  return model
    .split(':')[0]
    .toLowerCase()
    .replace(/-(coder|instruct|reasoning|chat|base|tiny|nano)$/, '');
}

function sizeOf(model) {
  const size = model.split(':')[1] || '';
  const match = size.match(/(\d+(?:\.\d+)?)(m|b)/i);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = parseFloat(match[1]);
  return match[2].toLowerCase() === 'b' ? value * 1000 : value;
}

function chooseModel(installed, realModel) {
  if (installed.includes(realModel)) {
    return { model: realModel, substituted: false, reason: null };
  }
  const fam = familyOf(realModel);
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const m of installed) {
    if (familyOf(m) !== fam) continue;
    const dist = Math.abs(sizeOf(m) - sizeOf(realModel)) + 0.5;
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  if (best) {
    return {
      model: best,
      substituted: true,
      reason: `"${realModel}" is not installed; using ${best} (same family)`,
    };
  }
  return { model: null, substituted: true, reason: `"${realModel}" is not installed` };
}

async function resolveModel(host, realModel) {
  const installed = await getInstalledModels(host);
  return chooseModel(installed, realModel);
}

async function ensure() {
  const host = Config.get('engineHost');

  if (!isEngineInstalled()) {
    await installEngine();
  }

  const running = await isEngineRunning(host);
  if (!running) {
    try {
      const child = exec('ollama serve', {
        stdio: 'ignore',
        detached: true,
      });
      if (child.unref) child.unref();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await isEngineRunning(host)) break;
      }
    } catch {}
  }

  const realModel = Catalog.getRealModel(Config.get('model'));
  const installed = await getInstalledModels(host);
  const resolved = chooseModel(installed, realModel);
  if (resolved.model == null) {
    await pullModel(host, realModel);
  }

  return true;
}

async function isReady() {
  const host = Config.get('engineHost');
  return isEngineRunning(host);
}

export const Engine = {
  ensure,
  isReady,
  pullModel,
  getInstalledModels,
  resolveModel,
  chooseModel,
  firstInstalled: async (host) => {
    const installed = await getInstalledModels(host);
    return installed[0] || null;
  },
};
