"""vcpu.py - virtual CPU manager in pure Python.

Creates a "virtual N-core CPU" out of the physical chip and binds work to it.
On big.LITTLE devices this picks the fast cores (e.g. Cortex-A78) for the
engine and leaves the little cores for the OS.

Run as a module:
  python -m vierrataleai.vcpu plan [--cores N]      print the recommended set
  python -m vierrataleai.vcpu self [--cores N]      pin this process to the set
  python -m vierrataleai.vcpu engine [--cores N]    relaunch engine pinned, detached
  python -m vierrataleai.vcpu server [--cores N]    run engine server pinned (foreground)
  python -m vierrataleai.vcpu status                show this process' affinity
  python -m vierrataleai.vcpu bench [--cores N]     run the full vCPU + VRAM + VGPU benchmark

The core count can also come from the VIERRATALE_VCPU_CORES environment
variable.
"""
import os
import subprocess
import time

N_VCPU = 8
ENGINE_BIN = "/usr/local/bin/ollama"

_vcpu_cache = (None, [])


def discover_topology():
    """Read per-core max frequencies from sysfs, return (big, little) lists."""
    big, little = [], []
    for cpu in range(os.cpu_count() or 1):
        try:
            with open(f"/sys/devices/system/cpu/cpu{cpu}/cpufreq/cpuinfo_max_freq") as fh:
                freq = int(fh.read().strip())
        except OSError:
            continue
        (big if freq >= 2400000 else little).append(cpu)
    if not big:
        big = [cpu for cpu in range(os.cpu_count() or 1) if cpu not in little]
    return sorted(big), sorted(little)


def n_vcpu(override=None):
    """Resolve the virtual CPU count: explicit flag, env, then the default."""
    n = override
    if n is None:
        env = (os.environ.get("VIERRATALE_VCPU_CORES") or "").strip()
        if env.isdigit():
            n = int(env)
    if n is None or n <= 0:
        n = N_VCPU
    total = os.cpu_count() or N_VCPU
    return min(n, total)


def vcpu_set(n=None):
    """Return a list of the `n` best virtual CPUs (fast big cores first)."""
    global _vcpu_cache
    n = n_vcpu(n)
    if _vcpu_cache[0] == n:
        return list(_vcpu_cache[1])
    big, little = discover_topology()
    ordered = big + little
    vcpus = sorted(ordered[:n])
    _vcpu_cache = (n, list(vcpus))
    return vcpus


def parse_mask(cpus):
    return ",".join(map(str, sorted(cpus)))


def pin_self(cpus=None):
    """Pin the current process (and its threads) to the given CPUs."""
    cpus = list(cpus) if cpus is not None else vcpu_set()
    os.sched_setaffinity(0, list(cpus))
    return os.sched_getaffinity(0)


def current_affinity(pid=None):
    return os.sched_getaffinity(pid if pid is not None else 0)


def start_engine(cpus=None):
    """Launch the local AI engine (Cortex) pinned to the virtual CPU set, detached."""
    cpus = list(cpus) if cpus else vcpu_set()
    cmd = ["taskset", "-c", parse_mask(cpus), ENGINE_BIN, "serve"]
    env = dict(os.environ)
    env["OLLAMA_NUM_THREADS"] = str(len(cpus))
    env["OLLAMA_GPU_OVERHEAD"] = "0"
    try:
        with open("/tmp/cortex.log", "w") as log:
            proc = subprocess.Popen(
                cmd, env=env, stdout=log, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, start_new_session=True,
            )
        return proc.pid
    except FileNotFoundError:
        print("taskset or Cortex engine not found; is the engine installed?")
        return None


def serve_engine(cpus=None):
    """Run the engine server pinned to the virtual CPU set, in the foreground."""
    cpus = list(cpus) if cpus else vcpu_set()
    cmd = ["taskset", "-c", parse_mask(cpus), ENGINE_BIN, "serve"]
    env = dict(os.environ)
    env["OLLAMA_NUM_THREADS"] = str(len(cpus))
    env["OLLAMA_GPU_OVERHEAD"] = "0"
    try:
        proc = subprocess.run(cmd, env=env, check=False)
        return proc.returncode
    except FileNotFoundError:
        print("taskset or Cortex engine not found; is the engine installed?")
        return 1


def _parse_args(args):
    cores = None
    for i, a in enumerate(args):
        if a == "--cores" and i + 1 < len(args):
            core = args[i + 1]
            if core.isdigit():
                cores = int(core)
    return cores


def main(argv=None):
    args = list(argv) if argv else []
    cmd = args[0] if args else "plan"
    cores = _parse_args(args)
    if cmd == "plan":
        cpus = vcpu_set(cores)
        print(f"virtual CPUs ({len(cpus)}): {parse_mask(cpus)}")
        print(f"fast big cores first, then little; engine num_thread={len(cpus)}")
    elif cmd == "self":
        got = pin_self(vcpu_set(cores))
        print(f"pinned PID {os.getpid()} to {len(got)} vCPUs -> {sorted(got)}")
    elif cmd == "engine":
        cpus = vcpu_set(cores)
        pid = start_engine(cpus)
        if pid:
            time.sleep(4)
            print(f"engine started pid={pid} aff={parse_mask(current_affinity(pid))}")
            print(f"engine pinned to {len(cpus)} vCPUs: {parse_mask(cpus)}")
    elif cmd == "server":
        cpus = vcpu_set(cores)
        print(f"serving engine on {len(cpus)} vCPUs: {parse_mask(cpus)} (Ctrl-C to stop)")
        return serve_engine(cpus)
    elif cmd == "status":
        print(f"pid={os.getpid()} aff={parse_mask(current_affinity())}")
    elif cmd == "bench":
        run_bench(cores)
    else:
        print(__doc__)
    return 0


def run_bench(cores=None):
    """Run the full benchmark: vCPU plan, VRAM bandwidth + latency, VGPU matmul."""
    from . import vram, vgpu

    cpus = vcpu_set(cores)
    os.sched_setaffinity(0, cpus)
    print(f"vCPU benchmark set ({len(cpus)}): {parse_mask(cpus)}")
    pool_mb = int(os.environ.get("VIERRATALE_VRAM_MB", "256"))
    vram.main(["--pool", str(pool_mb), "--threads", str(len(cpus)), "--latency"])
    vgpu.main(["--size", os.environ.get("VIERRATALE_VGPU_N", "128")])
    print("benchmark complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))