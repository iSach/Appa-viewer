"""Ensemble verification against an analysis, from the stored point files.

Only fields listed in POINT_FIELDS can be verified, because those are the only
ones for which every member is kept after publishing. Run it once the
analysis for the forecast's valid times is available (e.g. ERA5, ~5 days).
"""
import json
from pathlib import Path
from typing import Callable

import numpy as np

from .points import read_point  # noqa: F401  (reference reader, handy when debugging)


def lat_weights(lat: np.ndarray) -> np.ndarray:
    w = np.cos(np.deg2rad(lat))
    return (w / w.mean()).astype(np.float32)[:, None]


def crps_ensemble(members: np.ndarray, truth: np.ndarray) -> np.ndarray:
    """Standard ensemble CRPS per grid cell. members [M,H,W], truth [H,W]."""
    M = members.shape[0]
    term1 = np.abs(members - truth[None]).mean(0)
    term2 = np.zeros_like(term1)
    for i in range(M):
        term2 += np.abs(members[i][None] - members).sum(0)
    return term1 - 0.5 * term2 / (M * M)


def scores_for_frame(members: np.ndarray, truth: np.ndarray, w: np.ndarray) -> dict:
    mean = members.mean(0)
    err = mean - truth
    return {
        "rmse": float(np.sqrt((w * err ** 2).mean())),
        "bias": float((w * err).mean()),
        "crps": float((w * crps_ensemble(members, truth)).mean()),
        "spread": float(np.sqrt((w * members.var(0, ddof=1 if members.shape[0] > 1 else 0)).mean())),
    }


def load_members(path, entry) -> np.ndarray:
    """Whole point file -> float32 [M, T, H, W] (fine for a handful of fields)."""
    M, T, H, W = entry["members"], entry["times"], entry["height"], entry["width"]
    q = np.memmap(path, dtype="<u2", mode="r", shape=(H, W, M, T))
    lo, hi = entry["range"]
    return (np.asarray(q).astype(np.float32) / 65535.0 * (hi - lo) + lo).transpose(2, 3, 0, 1)


def verify_run(run_dir: Path, analysis: Callable[[str, int | None, list[str]], np.ndarray],
               max_lat_stride: int = 1) -> dict:
    """analysis(var, level, valid_times_iso) -> float32 [T, H, W] on the run's grid.

    Writes run_dir/verification.json and returns it.
    """
    run_dir = Path(run_dir)
    manifest = json.loads((run_dir / "manifest.json").read_text())
    out = {"run_id": manifest["run_id"], "lead_hours": manifest["lead_hours"], "fields": {}}
    for fid, entry in manifest["points"].items():
        stride = entry.get("stride", 1)
        lat = np.linspace(*manifest["grid"]["lat"], manifest["grid"]["height"], dtype=np.float32)[::stride]
        w = lat_weights(lat)[::max_lat_stride]
        members = load_members(run_dir / entry["file"], entry)[:, :, ::max_lat_stride]
        # The analysis comes on the full grid; sample it where the point file has data.
        truth = analysis(entry["variable"], entry["level"], manifest["valid_times"])[:, ::stride, ::stride][:, ::max_lat_stride]
        per_t = [scores_for_frame(members[:, t], truth[t], w) for t in range(members.shape[1])]
        out["fields"][fid] = {k: [sc[k] for sc in per_t] for k in ("rmse", "bias", "crps", "spread")}
    (run_dir / "verification.json").write_text(json.dumps(out))
    return out
