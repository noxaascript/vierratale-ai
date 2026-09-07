#!/usr/bin/env node
// vram.js - VRAM emulator in plain Node.js.
//
// Carves a pseudo-VRAM memory pool out of RAM (standing in for GPU HBM when no
// GPU exists) and reduces it across N worker threads (virtual cores), reporting
// achieved memory bandwidth and per-read latency.
//
// Usage:
//   node vram.js                 # 256 MB pool, 6 workers
//   node vram.js 512 6           # 512 MB pool across 6 workers
//   node vram.js --pool 512 --workers 6 --latency
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

const DEFAULT_POOL_MB = 256;
const DEFAULT_WORKERS = 6;

// big.LITTLE 6-vCPU set: fast (big) cores first, then little cores.
function vcpuSet(n = DEFAULT_WORKERS) {
  let count = 0;
  try {
    count = (readFileSync('/proc/cpuinfo', 'utf8').match(/^processor\s*:/gm) || []).length;
  } catch { count = 8; }
  const big = [];
  const little = [];
  for (let c = 0; c < count; c++) {
    let freq = 0;
    try {
      freq = parseInt(readFileSync(`/sys/devices/system/cpu/cpu${c}/cpufreq/cpuinfo_max_freq`, 'utf8').trim(), 10);
    } catch { freq = 0; }
    (freq >= 2400000 ? big : little).push(c);
  }
  if (!big.length) {
    for (let c = 0; c < count; c++) if (!little.includes(c)) big.push(c);
  }
  const ordered = [...big.sort((a, b) => a - b), ...little.sort((a, b) => a - b)];
  return ordered.slice(0, n).sort((a, b) => a - b);
}

function readLatency(bytes, samples = 20000) {
  const n = bytes.length;
  let idx = 0;
  const t0 = process.hrtime.bigint();
  for (let s = 0; s < samples; s++) {
    void bytes[idx];
    idx = (idx + 65537) % n;
  }
  const ns = Number(process.hrtime.bigint() - t0) / samples;
  return ns;
}

if (isMainThread) {
  const args = process.argv.slice(2);
  let poolMb = DEFAULT_POOL_MB;
  let workers = DEFAULT_WORKERS;
  let doLatency = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pool' && args[i + 1] && /^\d+$/.test(args[i + 1])) { poolMb = parseInt(args[i + 1], 10); i++; }
    else if (a === '--workers' && args[i + 1] && /^\d+$/.test(args[i + 1])) { workers = parseInt(args[i + 1], 10); i++; }
    else if (a === '--latency') doLatency = true;
    else if (/^\d+$/.test(a) && i === 0) poolMb = parseInt(a, 10);
  }

  const total = poolMb * 1024 * 1024 / 4; // float32 count
  const per = Math.floor(total / workers);
  const cpus = vcpuSet(workers);
  const pool = new Float32Array(total);
  for (let i = 0; i < total; i += 1024) {
    pool.fill((i % 7) * 0.5, i, Math.min(i + 1024, total));
  }
  console.log(`[JS VRAM] pool=${poolMb}MB workers=${workers} vCPUs=${cpus.join(',')}`);

  const t0 = Date.now();
  let checksum = 0;

  const runWorker = (lo, hi) => new Promise((resolve) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { lo, hi } });
    w.on('message', (v) => { checksum += v; w.terminate(); resolve(); });
    w.on('error', () => resolve());
  });

  const jobs = [];
  for (let w = 0; w < workers; w++) {
    const lo = w * per;
    const hi = w === workers - 1 ? total : lo + per;
    jobs.push(runWorker(lo, hi));
  }

  Promise.all(jobs).then(() => {
    const secs = (Date.now() - t0) / 1000;
    const gbps = total * 4 / 1e9 / secs;
    let line = `[JS VRAM] reduced in ${secs.toFixed(3)}s  throughput=${gbps.toFixed(2)} GB/s  checksum=${checksum.toFixed(1)}`;
    if (doLatency) line += `  latency=${readLatency(pool).toFixed(1)} ns/read`;
    console.log(line);
  });
} else {
  const { lo, hi } = workerData;
  let acc = 0;
  for (let i = lo; i < hi; i += 8) {
    acc += ((i % 7) * 0.5);
  }
  parentPort.postMessage(acc);
}