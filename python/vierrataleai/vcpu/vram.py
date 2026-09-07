"""vram.py - VRAM emulator in pure Python.

Carves a pseudo-VRAM memory pool out of RAM (standing in for GPU HBM when no
GPU exists) and reduces it across N virtual cores, reporting achieved memory
bandwidth. Optionally binds itself to the 6-vCPU set built by the vcpu module.

Run as a module:  python -m vierrataleai.vcpu.vram [poolMB] [threads] [pin]
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


def main(argv=None):
    args = list(sys.argv[1:]) if argv is None else list(argv)
    pool_mb = int(args[0]) if args and args[0].isdigit() else DEFAULT_POOL_MB
    threads = int(args[1]) if len(args) > 1 and args[1].isdigit() else DEFAULT_THREADS
    do_pin = "pin" in args

    if do_pin:
        os.sched_setaffinity(0, vcpu_set())
    aff = os.sched_getaffinity(0)
    print(f"[Py VRAM] pool={pool_mb}MB threads={threads} affinity={sorted(aff)}")

    vram = allocate_pool(pool_mb)
    total, secs = reduce(vram, threads)
    gbps = len(vram) * 4 / 1e9 / secs
    print(f"[Py VRAM] reduced in {secs:.3f}s  throughput={gbps:.2f} GB/s  checksum={total:.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())