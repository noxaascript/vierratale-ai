#!/usr/bin/env node
// vcpu.js - virtual CPU manager (8 vCPU) in plain Node.js.
//
// Creates a "virtual 8-core CPU" out of the physical chip and binds work to it.
// On big.LITTLE devices this picks the fast cores (e.g. Cortex-A78) first so
// the engine gets the fast cores; the little cores cover the OS.
//
// Usage:
//   node vcpu.js plan      # print the recommended 8-vCPU set
//   node vcpu.js engine    # relaunch the local AI engine on the set
//   node vcpu.js status    # print this process's affinity
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const N_VCPU = 8;
const ENGINE = '/usr/local/bin/ollama';

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

// big.LITTLE detection: big (fast) cores first, then little cores.
export function vcpuSet(n = N_VCPU) {
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
export function startEngine(cpus = vcpuSet()) {
  const mask = parseMask(cpus);
  const child = spawn(
    '/usr/bin/taskset',
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

function main() {
  const cmd = process.argv[2] || 'plan';
  if (cmd === 'plan') {
    const cpus = vcpuSet();
    console.log(`virtual CPUs (${cpus.length}): ${parseMask(cpus)}`);
    console.log(`fast big cores first, then little; engine num_thread=${cpus.length}`);
  } else if (cmd === 'engine') {
    const pid = startEngine();
    console.log(`engine relaunching pid=${pid} on vCPUs ${parseMask(vcpuSet())}`);
  } else if (cmd === 'status') {
    try {
      const allowed = readFileSync(`/proc/${process.pid}/status`, 'utf8')
        .match(/Cpus_allowed_list:\s*(\S+)/);
      console.log(`pid=${process.pid} aff=${allowed ? allowed[1] : 'unknown'}`);
    } catch {
      console.log('status unavailable');
    }
  } else {
    console.log('usage: node vcpu.js <plan|engine|status>');
  }
}

if (process.argv[1] && process.argv[1].endsWith('vcpu.js')) main();
