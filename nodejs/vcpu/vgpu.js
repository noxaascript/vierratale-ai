#!/usr/bin/env node
// vgpu.js - virtual GPU (VGPU) matmul benchmark in plain Node.js.
//
// Emulates a GPU matmul kernel over the virtual CPU set: multiplies two NxN
// float32 matrices and reports achieved GFLOPS / TOPS plus effective memory
// bandwidth. Rows are fanned out across worker threads (virtual tensor cores).
//
// Usage:
//   node vgpu.js                 # 128x128 matmul, 6 workers
//   node vgpu.js --size 256 --workers 6
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const DEFAULT_N = 128;
const DEFAULT_WORKERS = 6;

if (isMainThread) {
  const args = process.argv.slice(2);
  let n = DEFAULT_N;
  let workers = DEFAULT_WORKERS;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--size' && args[i + 1] && /^\d+$/.test(args[i + 1])) { n = parseInt(args[i + 1], 10); i++; }
    else if (a === '--workers' && args[i + 1] && /^\d+$/.test(args[i + 1])) { workers = parseInt(args[i + 1], 10); i++; }
  }

  const sabA = new SharedArrayBuffer(n * n * 4);
  const sabB = new SharedArrayBuffer(n * n * 4);
  const A = new Float32Array(sabA);
  const B = new Float32Array(sabB);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      A[i * n + j] = ((i * 3 + j * 5) % 11) * 0.25;
      B[i * n + j] = ((i * 3 + j * 5) % 11) * 0.25;
    }
  }
  console.log(`[JS VGPU] matmul ${n}x${n} workers=${workers}`);

  const t0 = process.hrtime.bigint();
  let checksum = 0;

  const runWorker = (lo, hi) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { sabA, sabB, n, lo, hi } });
    w.on('message', (v) => { checksum += v; w.terminate(); resolve(); });
    w.on('error', reject);
  });

  const per = Math.floor(n / workers);
  const jobs = [];
  for (let w = 0; w < workers; w++) {
    const lo = w * per;
    const hi = w === workers - 1 ? n : lo + per;
    jobs.push(runWorker(lo, hi));
  }

  Promise.all(jobs).then(() => {
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    const flops = 2 * n * n * n;
    const gflops = flops / 1e9 / secs;
    const tops = flops / 1e12 / secs;
    const gbps = n * n * 3 * 4 / 1e9 / secs;
    console.log(
      `[JS VGPU] matmul ${n}x${n} in ${secs.toFixed(3)}s  throughput=${gflops.toFixed(4)} GFLOPS / ${tops.toFixed(6)} TOPS  ` +
      `bandwidth=${gbps.toFixed(2)} GB/s  checksum=${checksum.toFixed(1)}`,
    );
  });
} else {
  const { sabA, sabB, n, lo, hi } = workerData;
  const A = new Float32Array(sabA);
  const B = new Float32Array(sabB);
  let acc = 0;
  for (let i = lo; i < hi; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += A[i * n + k] * B[k * n + j];
      acc += s;
    }
  }
  parentPort.postMessage(acc);
}