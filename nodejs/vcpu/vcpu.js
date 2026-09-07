#!/usr/bin/env node
// vcpu.js - virtual CPU manager in plain Node.js.
//
// Creates a "virtual N-core CPU" out of the physical chip and binds work to it.
// On big.LITTLE devices this picks the fast cores (e.g. Cortex-A78) first so
// the engine gets the fast cores; the little cores cover the OS.
//
// Usage:
//   node vcpu.js plan [--cores N]      # print the recommended N-core set
//   node vcpu.js engine [--cores N]    # relaunch the local AI engine on the set
//   node vcpu.js server [--cores N]    # run the engine server pinned (foreground)
//   node vcpu.js status                # print this process's affinity
//   node vcpu.js bench [--cores N]     # run the full vCPU + VRAM + VGPU benchmark
//
// The core count can also come from the VIERRATALE_VCPU_CORES env variable.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const N_VCPU = 8;
const ENGINE = '/usr/local/bin/ollama';
const TASKSET = '/usr/bin/taskset';

function cpuCount() {
  try {
    return (readFileSync('/proc/cpuinfo', 'utf8').match(/^processor\s*:/gm) || []).length;
  } catch {
    return 8;
  }
}

function maxFreq(cpu) {
  try {
    return parseInt(
      readFileSync(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/cpuinfo_max_freq`, 'utf8').trim(),
      10,
    );
  } catch {
    return 0;
  }
}

export function nVcpu(override) {
  let n = override;
  const env = (process.env.VIERRATALE_VCPU_CORES || '').trim();
  if (n == null && /^\d+$/.test(env)) n = parseInt(env, 10);
  if (n == null || n <= 0) n = N_VCPU;
  return Math.min(n, cpuCount());
}

// big.LITTLE detection: big (fast) cores first, then little cores.
export function vcpuSet(n) {
  n = nVcpu(n);
  const count = cpuCount();
  const big = [];
  const little = [];
  for (let c = 0; c < count; c++) {
    (maxFreq(c) >= 2400000 ? big : little).push(c);
  }
  if (!big.length) {
    for (let c = 0; c < count; c++) if (!little.includes(c)) big.push(c);
  }
  const ordered = [...big.sort((a, b) => a - b), ...little.sort((a, b) => a - b)];
  return ordered.slice(0, n).sort((a, b) => a - b);
}

export function parseMask(cpus) {
  return cpus.join(',');
}

// Relaunch the engine pinned to the virtual CPU set, detached.
export function startEngine(cpus) {
  cpus = vcpuSet(cpus == null ? undefined : cpus);
  const mask = parseMask(cpus);
  const child = spawn(
    TASKSET,
    ['-c', mask, ENGINE, 'serve'],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, OLLAMA_NUM_THREADS: String(cpus.length), OLLAMA_GPU_OVERHEAD: '0' },
    },
  );
  child.unref();
  return child.pid;
}

// Run the engine server pinned to the set, in the foreground.
export function runServer(cpus) {
  cpus = vcpuSet(cpus == null ? undefined : cpus);
  const mask = parseMask(cpus);
  const res = spawnSync(
    TASKSET,
    ['-c', mask, ENGINE, 'serve'],
    { stdio: 'inherit', env: { ...process.env, OLLAMA_NUM_THREADS: String(cpus.length), OLLAMA_GPU_OVERHEAD: '0' } },
  );
  return res.status;
}

function argCores(args) {
  const i = args.indexOf('--cores');
  const env = (process.env.VIERRATALE_VCPU_CORES || '').trim();
  const n = i >= 0 && args[i + 1] && /^\d+$/.test(args[i + 1]) ? parseInt(args[i + 1], 10) : null;
  return nVcpu(n == null ? (env ? parseInt(env, 10) : null) : n);
}

function runBench(cpus) {
  const mask = parseMask(cpus);
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const pool = process.env.VIERRATALE_VRAM_MB || '256';
  const vgpuN = process.env.VIERRATALE_VGPU_N || '128';
  console.log(`vCPU benchmark set (${cpus.length}): ${mask}`);
  spawnSync(TASKSET, ['-c', mask, process.execPath, `${dir}vram.js`, '--pool', pool, '--workers', String(cpus.length), '--latency'], { stdio: 'inherit' });
  spawnSync(TASKSET, ['-c', mask, process.execPath, `${dir}vgpu.js`, '--size', vgpuN, '--workers', String(cpus.length)], { stdio: 'inherit' });
  console.log('benchmark complete');
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'plan';
  if (cmd === 'plan') {
    const cpus = vcpuSet(argCores(args));
    console.log(`virtual CPUs (${cpus.length}): ${parseMask(cpus)}`);
    console.log(`fast big cores first, then little; engine num_thread=${cpus.length}`);
  } else if (cmd === 'engine') {
    const cpus = vcpuSet(argCores(args));
    const pid = startEngine(cpus);
    console.log(`engine relaunching pid=${pid} on vCPUs ${parseMask(cpus)}`);
  } else if (cmd === 'server') {
    const cpus = vcpuSet(argCores(args));
    console.log(`serving engine on ${cpus.length} vCPUs: ${parseMask(cpus)} (Ctrl-C to stop)`);
    process.exitCode = runServer(cpus);
  } else if (cmd === 'status') {
    try {
      const allowed = readFileSync(`/proc/${process.pid}/status`, 'utf8')
        .match(/Cpus_allowed_list:\s*(\S+)/);
      console.log(`pid=${process.pid} aff=${allowed ? allowed[1] : 'unknown'}`);
    } catch {
      console.log('status unavailable');
    }
  } else if (cmd === 'bench') {
    runBench(vcpuSet(argCores(args)));
  } else {
    console.log('usage: node vcpu.js <plan|engine|server|status|bench> [--cores N]');
  }
}

if (process.argv[1] && process.argv[1].endsWith('vcpu.js')) main();