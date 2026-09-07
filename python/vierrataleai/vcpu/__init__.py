"""vCPU + VRAM package for VierrataleAI.

Run vCPU manager:  python -m vierrataleai.vcpu [plan|self|engine|status]
Run VRAM demo:     python -m vierrataleai.vcpu.vram [poolMB] [threads] [pin]
"""
from .vcpu import (
    N_VCPU,
    current_affinity,
    discover_topology,
    parse_mask,
    pin_self,
    start_engine,
    vcpu_set,
)
from .vram import allocate_pool, reduce

__all__ = [
    "N_VCPU",
    "allocate_pool",
    "current_affinity",
    "discover_topology",
    "parse_mask",
    "pin_self",
    "reduce",
    "start_engine",
    "vcpu_set",
]
