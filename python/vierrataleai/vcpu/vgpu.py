"""vgpu.py - virtual GPU (VGPU) matmul benchmark in pure Python.

Emulates a GPU matmul kernel over the virtual CPU set: multiplies two NxN
float32 matrices and reports achieved GFLOPS / TOPS plus effective memory
bandwidth. No GPU or NumPy required — the "tensor core" is a float32 dot
product fanned out over the vCPU threads (sum(map(mul, ...)) so the inner
loop runs mostly in C).

Run as a module:
  python -m vierrataleai.vcpu.vgpu [N] [threads] [pin]
  python -m vierrataleai.vcpu.vgpu --size 128 --threads 6
"""
import array
import os
import sys
import threading
import time
from operator import mul

from .vcpu import vcpu_set

DEFAULT_N = 128
DEFAULT_THREADS = 6


def allocate_matrix(n):
    """Allocate an NxN float32 matrix with deterministic warm data."""
    m = array.array("f", [0.0]) * (n * n)
    for i in range(n):
        row = i * n
        for j in range(n):
            m[row + j] = float(((i * 3 + j * 5) % 11) * 0.25)
    return m


def transpose(b, n):
    """Return a list of column arrays so the matmul inner loop is contiguous."""
    return [array.array("f", (b[k * n + j] for k in range(n))) for j in range(n)]


def matmul_rows(a, bcols, c, n, i0, i1):
    """Compute dense matmul C = A x B for rows [i0, i1) of C."""
    for i in range(i0, i1):
        row = a[i * n:i * n + n]
        base = i * n
        for j in range(n):
            c[base + j] = sum(map(mul, row, bcols[j]))


def matmul(a, b, n, threads):
    """Parallel matmul C = A x B over `threads` virtual cores."""
    bcols = transpose(b, n)
    c = array.array("f", [0.0]) * (n * n)
    per = n // threads
    t0 = time.time()
    pool = [
        threading.Thread(target=matmul_rows, args=(a, bcols, c, n, t * per, n if t == threads - 1 else (t + 1) * per))
        for t in range(threads)
    ]
    for t in pool:
        t.start()
    for t in pool:
        t.join()
    secs = time.time() - t0
    return sum(c), secs


def main(argv=None):
    args = list(sys.argv[1:]) if argv is None else list(argv)
    n = DEFAULT_N
    threads = DEFAULT_THREADS
    do_pin = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--size" and i + 1 < len(args) and args[i + 1].isdigit():
            n = int(args[i + 1]); i += 2
        elif a == "--threads" and i + 1 < len(args) and args[i + 1].isdigit():
            threads = int(args[i + 1]); i += 2
        elif a == "--pin" or a == "pin":
            do_pin = True; i += 1
        elif a.isdigit():
            if i == 0:
                n = int(a)
            i += 1
        else:
            i += 1

    if do_pin:
        os.sched_setaffinity(0, vcpu_set())
    aff = os.sched_getaffinity(0)
    print(f"[Py VGPU] matmul {n}x{n} threads={threads} affinity={sorted(aff)}")

    a = allocate_matrix(n)
    b = allocate_matrix(n)
    checksum, secs = matmul(a, b, n, threads)
    flops = 2.0 * n * n * n
    gflops = flops / 1e9 / secs
    tops = flops / 1e12 / secs
    bytes_touched = n * n * 3 * 4
    gbps = bytes_touched / 1e9 / secs
    print(
        f"[Py VGPU] matmul {n}x{n} in {secs:.3f}s  throughput={gflops:.4f} GFLOPS / {tops:.6f} TOPS  "
        f"bandwidth={gbps:.2f} GB/s  checksum={checksum:.1f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))