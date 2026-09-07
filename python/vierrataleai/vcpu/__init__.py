"""vCPU + VRAM + VGPU package for VierrataleAI.

Run vCPU manager:  python -m vierrataleai.vcpu [plan|self|engine|server|status|bench]
Run VRAM demo:     python -m vierrataleai.vcpu.vram [poolMB] [threads] [pin]
Run VGPU demo:     python -m vierrataleai.vcpu.vgpu [N] [threads] [pin]
"""
from .vcpu import (
    N_VCPU,
    current_affinity,
    discover_topology,
    n_vcpu,
    parse_mask,
    pin_self,
    serve_engine,
    start_engine,
    vcpu_set,
)
from .vram import allocate_pool, reduce, read_latency
from .vgpu import allocate_matrix, matmul

__all__ = [
    "N_VCPU",
    "allocate_matrix",
    "allocate_pool",
    "current_affinity",
    "discover_topology",
    "matmul",
    "n_vcpu",
    "parse_mask",
    "pin_self",
    "read_latency",
    "reduce",
    "serve_engine",
    "start_engine",
    "vcpu_set",
]