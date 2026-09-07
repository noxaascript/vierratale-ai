import { execSync, exec } from 'child_process';
import { existsSync, mkdirSync, symlinkSync, chmodSync, writeFileSync, lstatSync, readlinkSync, rmSync, realpathSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';
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

// Scripts in the same model family share a base name before any variant
// suffix (e.g. qwen2.5-coder:1.5b is the sibling of qwen2.5:1.5b).
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

// Find the already-installed model that best matches the requested one.
// Prefers an exact match, then any same-family sibling (closest size).
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

// Best local bin dir for a globally-callable command on this platform.
function localBinDir() {
  if (process.env.XDG_BIN_HOME) return process.env.XDG_BIN_HOME;
  if (process.env.HOME) return join(homedir(), '.local', 'bin');
  return '/usr/local/bin';
}

function isOnPath(dir) {
  const sep = platform() === 'win32' ? ';' : ':';
  let dirResolved;
  try {
    dirResolved = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  } catch {
    dirResolved = resolve(dir);
  }
  return String(process.env.PATH || '')
    .split(sep)
    .some((entry) => {
      entry = entry.trim();
      if (!entry) return false;
      try {
        const e = existsSync(entry) ? realpathSync(entry) : resolve(entry);
        return e === dirResolved;
      } catch {
        return false;
      }
    });
}

// Prefer a bin dir that is already on PATH (and writable) so the installed
// command is callable immediately; fall back to the local bin dir.
function chooseBinDir() {
  const local = localBinDir();
  if (isOnPath(local)) return local;
  for (const candidate of ['/usr/local/bin', '/usr/bin']) {
    try {
      mkdirSync(candidate, { recursive: true, mode: 0o755 });
      const probe = join(candidate, `.vierrataleai-write-test-${process.pid}`);
      writeFileSync(probe, '');
      rmSync(probe, { force: true });
      return candidate;
    } catch {}
  }
  return local;
}

// Create (or refresh) a launcher link for `name` pointing at the node bin.
function writeLauncher(dir, name, target) {
  const launcherPath = join(dir, name);
  if (platform() === 'win32') {
    if (!existsSync(launcherPath)) {
      writeFileSync(launcherPath, `@echo off\r\nnode "${target}" %*\r\n`);
    }
    return launcherPath;
  }
  // Prefer a real symlink; fall back to a small shim that calls the node bin.
  let live = false;
  try {
    live = lstatSync(launcherPath).isSymbolicLink() && readlinkSync(launcherPath) === target;
  } catch {}
  if (!live) {
    rmSync(launcherPath, { force: true });
    try {
      symlinkSync(target, launcherPath);
      chmodSync(launcherPath, 0o755);
    } catch {
      writeFileSync(launcherPath, `#!/bin/sh\nnode "${target}" "$@"\n`);
      chmodSync(launcherPath, 0o755);
    }
  }
  return launcherPath;
}

function installAppCommand() {
  try {
    const dir = chooseBinDir();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const defaultTarget = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vierrataleai.js');
    const target = process.argv[1] && existsSync(process.argv[1]) ? process.argv[1] : defaultTarget;
    // Both spellings run the assistant.
    const launcherPath = writeLauncher(dir, 'vierrataleai', target);
    writeLauncher(dir, 'vierratale', target);
    return launcherPath;
  } catch {
    return null;
  }
}

export const Installer = {
  async pullModel(host, model) {
    return pullModel(host, model);
  },

  async getInstalledModels(host) {
    return getInstalledModels(host);
  },

  async resolveModel(host, realModel) {
    return resolveModel(host, realModel);
  },

  async firstInstalled(host) {
    const installed = await getInstalledModels(host);
    return installed[0] || null;
  },

  chooseModel,

  installAppCommand,
  isOnPath,

  async ensure() {
    const host = Config.get('engineHost');

    if (!isEngineInstalled()) {
      await installEngine();
    }

    const running = await isEngineRunning(host);
    if (!running) {
      try {
        // No systemd available here, so launch the daemon directly, detached,
        // and poll until it responds instead of relying on a service manager.
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
    const needsPull = resolved.model == null;

    if (needsPull) {
      await pullModel(host, realModel);
    }

    return true;
  },

  async isReady() {
    const host = Config.get('engineHost');
    return isEngineRunning(host);
  },

  // Full install: engine + model + a global "vierrataleai" command.
  async install({ includeCommand = true } = {}) {
    const host = Config.get('engineHost');

    if (!isEngineInstalled()) {
      await installEngine();
    }

    const running = await isEngineRunning(host);
    if (!running) {
      try {
        const child = exec('ollama serve', { stdio: 'ignore', detached: true });
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

    let command = null;
    let commandAlias = null;
    let commandOnPath = false;
    if (includeCommand) {
      command = installAppCommand();
      if (command) {
        commandAlias = join(dirname(command), 'vierratale');
        commandOnPath = isOnPath(dirname(command));
      }
    }
    return { installed: await isEngineInstalled(), running: await isEngineRunning(host), command, commandAlias, commandOnPath };
  },
};
