"""Ensemble statistics in one pass on the GPU (CPU fallback).

Members are never written to disk and re-read: a [M, T, H, W] tensor goes in,
every requested product comes out.
"""
import numpy as np
import torch

from .spec import ProductSpec


def device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def to_tensor(members: np.ndarray) -> torch.Tensor:
    return torch.from_numpy(np.ascontiguousarray(members, dtype=np.float32)).to(device())


def relative_humidity(t: torch.Tensor, q: torch.Tensor, level_hpa: float) -> torch.Tensor:
    """RH [%] from temperature [K] and specific humidity [kg/kg] (Bolton 1980)."""
    tc = t - 273.15
    es = 6.112 * torch.exp(17.67 * tc / (tc + 243.5))
    e = q * level_hpa / (0.622 + 0.378 * q)
    return (100.0 * e / es).clamp(0.0, 100.0)


def wind_speed(u: torch.Tensor, v: torch.Tensor) -> torch.Tensor:
    return torch.sqrt(u * u + v * v)


def compute_product(members: torch.Tensor, p: ProductSpec) -> torch.Tensor:
    """[M, T, H, W] -> [T, H, W] for one product."""
    if p.name == "mean":
        return members.mean(0)
    if p.name == "std":
        return members.std(0, unbiased=False)
    if p.quantile is not None:
        return torch.quantile(members, p.quantile, dim=0)
    if p.threshold is not None:
        _, _, thr, direction = p.threshold
        hit = members > thr if direction == "above" else members < thr
        return hit.float().mean(0)
    raise ValueError(f"unknown product {p.name}")
