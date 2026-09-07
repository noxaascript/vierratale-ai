"""vram.py - VRAM emulator in pure Python.

Carves a pseudo-VRAM memory pool out of RAM (standing in for GPU HBM when no
GPU exists) and reduces it across N virtual cores, reporting achieved memory
bandwidth and per-read latency. Optionally binds itself to the vCPU set built
by the vcpu module.

Run as a module:
  python -m vierrataleai.vcpu.vram [poolMB] [threads] [pin]
  python -m vierrataleai.vcpu.vram --pool 512 --threads 6 --latency
"""
import array
import os
import sys
import threading
import time

from .vcpu import vcpu_set

DEFAULT_POOL_MB = 256
DEFAULT_THREADS = 6


def allocate_pool(mb, zero=False):
    """Allocate the pseudo-VRAM pool (a single contiguous array of floats)."""
    n = mb * 1024 * 1024 // 4
    if zero:
        return array.array("f", [0.0]) * n
    vram = array.array("f", [0.0]) * n
    for i in range(0, n, 1024):
        vram[i:i + 1024] = array.array("f", [float(i % 7) * 0.5]) * 1024
    return vram


def reduce(vram, threads):
    """Parallel tensor reduction over `threads` virtual cores."""
    n = len(vram)
    per = n // threads
    lock = threading.Lock()
    total = [0.0]

    def work(lo, hi):
        acc = 0.0
        for i in range(lo, hi, 8):
            acc += vram[i]
        with lock:
            total[0] += acc

    pool = [
        threading.Thread(
            target=work,
            args=(t * per, n if t == threads - 1 else (t + 1) * per),
        )
        for t in range(threads)
    ]
    t0 = time.time()
    for t in pool:
        t.start()
    for t in pool:
        t.join()
    secs = time.time() - t0
    return total[0], secs


def read_latency(vram, samples=20000):
    """Measure per-read latency (ns) with a strided hot loop on one thread."""
    n = len(vram)
    idx = 0
    t0 = time.time()
    for _ in range(samples):
        _ = vram[idx]
        idx = (idx + 65537) % n - 1  # keep reads spread across the pool
        idx = idx if idx >= 0 else 0
    secs = (time.time() - t0) / samples
    return secs * 1e9


def main(argv=None):
    args = list(sys.argv[1:]) if argv is None else list(argv)
    pool_mb = DEFAULT_POOL_MB
    threads = DEFAULT_THREADS
    do_pin = False
    do_latency = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--pool" and i + 1 < len(args) and args[i + 1].isdigit():
            pool_mb = int(args[i + 1]); i += 2
        elif a == "--threads" and i + 1 < len(args) and args[i + 1].isdigit():
            threads = int(args[i + 1]); i += 2
        elif a == "--latency":
            do_latency = True; i += 1
        elif a == "--pin" or a == "pin":
            do_pin = True; i += 1
        elif a.isdigit():
            if i == 0:
                pool_mb = int(a)
            i += 1
        else:
            i += 1

    if do_pin:
        os.sched_setaffinity(0, vcpu_set())
    aff = os.sched_getaffinity(0)
    print(f"[Py VRAM] pool={pool_mb}MB threads={threads} affinity={sorted(aff)}")

    vram = allocate_pool(pool_mb)
    total, secs = reduce(vram, threads)
    gbps = len(vram) * 4 / 1e9 / secs
    line = f"[Py VRAM] reduced in {secs:.3f}s  throughput={gbps:.2f} GB/s  checksum={total:.1f}"
    if do_latency:
        lat = read_latency(vram)
        line += f"  latency={lat:.1f} ns/read"
    print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())