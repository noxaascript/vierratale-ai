"""vcpu.py - virtual CPU manager (8 vCPU) in pure Python.

Creates a "virtual 8-core CPU" out of the physical chip and binds work to it.
On big.LITTLE devices this picks the fast cores (e.g. Cortex-A78) for the
engine and leaves the little cores for the OS.

Run as a module:  python -m vierrataleai.vcpu [plan|self|engine|status]
"""
import os
import subprocess
import time

N_VCPU = 8


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


def vcpu_set(n=N_VCPU):
    """Return a list of the `n` best virtual CPUs (fast big cores first)."""
    big, little = discover_topology()
    ordered = big + little
    return sorted(ordered[:n])


def parse_mask(cpus):
    return ",".join(map(str, sorted(cpus)))


def pin_self(cpus):
    """Pin the current process (and its threads) to the given CPUs."""
    os.sched_setaffinity(0, list(cpus))
    return os.sched_getaffinity(0)


def current_affinity(pid=None):
    return os.sched_getaffinity(pid if pid is not None else 0)


def start_engine(cpus=None):
    """Launch the AI engine (ollama) pinned to the virtual CPU set, detached."""
    cpus = list(cpus) if cpus else vcpu_set()
    cmd = ["taskset", "-c", parse_mask(cpus), "/usr/local/bin/ollama", "serve"]
    env = dict(os.environ)
    env["OLLAMA_NUM_THREADS"] = str(len(cpus))
    env["OLLAMA_GPU_OVERHEAD"] = "0"
    try:
        with open("/tmp/ollama.log", "w") as log:
            proc = subprocess.Popen(
                cmd, env=env, stdout=log, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, start_new_session=True,
            )
        return proc.pid
    except FileNotFoundError:
        print("taskset or ollama not found; is the engine installed?")
        return None


def main(argv=None):
    args = list(argv) if argv else []
    cmd = args[0] if args else "plan"
    if cmd == "plan":
        cpus = vcpu_set()
        print(f"virtual CPUs ({len(cpus)}): {parse_mask(cpus)}")
        print(f"fast big cores first, then little; engine num_thread={len(cpus)}")
    elif cmd == "self":
        n = int(args[1]) if len(args) > 1 else N_VCPU
        got = pin_self(vcpu_set(n))
        print(f"pinned PID {os.getpid()} to {n} vCPUs -> {sorted(got)}")
    elif cmd == "engine":
        pid = start_engine()
        if pid:
            time.sleep(4)
            print(f"engine started pid={pid} aff={parse_mask(current_affinity(pid))}")
    elif cmd == "status":
        print(f"pid={os.getpid()} aff={parse_mask(current_affinity())}")
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())