"""Build one published run from an ensemble source.

    python -m appa_live2.build --synthetic --out web/data
    python -m appa_live2.build --members run/*_0.zarr run/*_1.zarr --out /var/www/appa/data

Output (everything static, written into a hidden .partial dir and renamed into
place at the end, so readers never see a half-written run):

    latest.json                         pointer to the newest complete run
    runs/<run_id>/manifest.json
    runs/<run_id>/fields/<product>/<field>.pack   concatenated PNG frames
    runs/<run_id>/fields/wind/wind_<level>.pack   u/v wind frames
    runs/<run_id>/points/<field>.u16              [H,W,M,T] per-gridpoint ensemble
"""
import argparse
import json
import logging
import os
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import torch

from . import encode, stats
from .points import write_points
from .spec import (PRODUCTS, POINT_FIELDS, PRESSURE_LEVELS, VARIABLES, WIND_PAIRS,
                   ProductSpec, VarSpec, field_id)
from .sources import ERA5Source, Source, SyntheticSource, ZarrSource

log = logging.getLogger("appa_live2")

SCHEMA = 1


def load_field(src: Source, var: str, level: int | None) -> torch.Tensor:
    """[M, T, H, W] tensor on the compute device, deriving variables if needed."""
    if var == "10m_wind_speed":
        u = stats.to_tensor(src.raw("10m_u_component_of_wind", None))
        v = stats.to_tensor(src.raw("10m_v_component_of_wind", None))
        return stats.wind_speed(u, v)
    if var == "wind_speed":
        u = stats.to_tensor(src.raw("u_component_of_wind", level))
        v = stats.to_tensor(src.raw("v_component_of_wind", level))
        return stats.wind_speed(u, v)
    if var == "relative_humidity":
        t = stats.to_tensor(src.raw("temperature", level))
        q = stats.to_tensor(src.raw("specific_humidity", level))
        return stats.relative_humidity(t, q, float(level))
    return stats.to_tensor(src.raw(var, level))


def applies(p: ProductSpec, var: str, level: int | None) -> bool:
    if p.threshold is not None:
        return p.threshold[0] == var and p.threshold[1] == level
    if p.variables is not None and var not in p.variables:
        return False
    if level is not None and p.levels is not None and level not in p.levels:
        return False
    return True


def _write_field(run_dir: Path, product: str, fid: str, frames: np.ndarray, lo, hi, bits, transform,
                 disp):
    rel = f"fields/{product}/{fid}.pack"
    (run_dir / "fields" / product).mkdir(parents=True, exist_ok=True)
    blobs = encode.encode_frames(frames, lo, hi, bits, transform)
    index = encode.write_pack(run_dir / rel, blobs)
    return {"file": rel, "range": [lo, hi], "display_range": list(disp), "bits": bits,
            "transform": transform, "frames": index}


def build_field(run_dir: Path, src: Source, spec: VarSpec, level: int | None,
                products: list[ProductSpec], point_fields, manifest: dict, point_stride: int = 1):
    fid = field_id(spec.name, level)
    members = load_field(src, spec.name, level)
    todo = [p for p in products if applies(p, spec.name, level)]
    if src.n_members == 1:  # spread, quantiles and probabilities need an ensemble
        todo = [p for p in todo if p.name == "mean"]
    results = {p.name: stats.compute_product(members, p).cpu().numpy() for p in todo}

    # mean / quantiles share one colour scale so they are comparable on screen.
    value = [n for n in results if not n.startswith(("std", "prob"))]
    if value:
        stacked = np.stack([results[n] for n in value])
        lo, hi = encode.full_range(stacked, spec.transform)
        disp = encode.display_range(stacked)
    for p in todo:
        if p.name in value:
            entry = _write_field(run_dir, p.name, fid, results[p.name], lo, hi, spec.bits, spec.transform, disp)
        elif p.name.startswith("prob"):
            entry = _write_field(run_dir, p.name, fid, results[p.name], 0.0, 1.0, 8, "linear", (0.0, 1.0))
        else:  # std: 0..max, colour scale from robust quantile
            _, smax = encode.full_range(results[p.name], "linear")
            entry = _write_field(run_dir, p.name, fid, results[p.name], 0.0, smax, 8, "linear",
                                 (0.0, encode.display_range(results[p.name])[1]))
        manifest["fields"].setdefault(p.name, {})[fid] = entry

    if (spec.name, level) in point_fields:
        (run_dir / "points").mkdir(exist_ok=True)
        entry = write_points(run_dir / "points" / f"{fid}.u16", members, stride=point_stride)
        entry.update(file=f"points/{fid}.u16", variable=spec.name, level=level)
        manifest["points"][fid] = entry


def build_wind(run_dir: Path, src: Source, manifest: dict):
    (run_dir / "fields" / "wind").mkdir(parents=True, exist_ok=True)
    jobs = [("10m", WIND_PAIRS[None], None)] + [(str(l), WIND_PAIRS["levels"], l) for l in src.levels]
    for key, (uvar, vvar), level in jobs:
        u = stats.to_tensor(src.raw(uvar, level)).mean(0).cpu().numpy()
        v = stats.to_tensor(src.raw(vvar, level)).mean(0).cpu().numpy()
        vmax = float(max(1.0, np.ceil(np.quantile(np.hypot(u, v)[:, ::4, ::4], 0.999))))
        blobs = [encode.wind_png_bytes(u[t], v[t], vmax) for t in range(u.shape[0])]
        rel = f"fields/wind/wind_{key}.pack"
        manifest["wind"][key] = {"file": rel, "vmax": vmax,
                                 "frames": encode.write_pack(run_dir / rel, blobs)}


def build_run(src: Source, out_root: Path, products=PRODUCTS, point_fields=POINT_FIELDS,
              keep_runs: int = 4, point_stride: int = 1) -> Path:
    t0 = time.time()
    out_root = Path(out_root)
    run_id = src.init_time.strftime("%Y-%m-%dT%HZ") + f"_PT{len(src.times)}H"
    partial = out_root / "runs" / f".{run_id}.partial"
    if partial.exists():
        shutil.rmtree(partial)
    partial.mkdir(parents=True)
    H, W = len(src.lat), len(src.lon)
    manifest = {
        "schema": SCHEMA, "run_id": run_id,
        "init_time": src.init_time.isoformat(),
        "valid_times": [t.isoformat() for t in src.times],
        "lead_hours": [(t - src.init_time).total_seconds() / 3600 for t in src.times],
        "members": src.n_members, "kind": src.kind,
        "grid": {"width": W, "height": H, "lat": [float(src.lat[0]), float(src.lat[-1])],
                 "lon": [float(src.lon[0]), float(src.lon[-1])]},
        "levels": list(src.levels),
        "variables": {}, "products": {p.name: {"label": p.label, "colormap": p.colormap} for p in products},
        "fields": {}, "wind": {}, "points": {},
    }
    for spec in VARIABLES.values():
        manifest["variables"][spec.name] = {
            "label": spec.label, "unit": spec.unit, "colormap": spec.colormap,
            "unit_scale": spec.unit_scale, "unit_offset": spec.unit_offset,
            "levels": list(src.levels) if spec.levels else None,
            "transparent_below": spec.transparent_below,
        }
        for level in (list(src.levels) if spec.levels else [None]):
            build_field(partial, src, spec, level, products, set(point_fields), manifest, point_stride)
        log.info("built %s (%.1fs)", spec.name, time.time() - t0)
    build_wind(partial, src, manifest)
    # allow_nan=False: browsers reject NaN in JSON, so fail here instead of publishing a broken run.
    (partial / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":"), allow_nan=False))
    final = publish(out_root, partial, run_id, manifest, keep_runs)
    log.info("published %s in %.1fs", final, time.time() - t0)
    return final


def publish(out_root: Path, partial: Path, run_id: str, manifest: dict, keep_runs: int) -> Path:
    final = out_root / "runs" / run_id
    if final.exists():
        shutil.rmtree(final)
    os.replace(partial, final)
    pointer = {"run_id": run_id, "init_time": manifest["init_time"],
               "manifest": f"runs/{run_id}/manifest.json"}
    tmp = out_root / ".latest.json.tmp"
    tmp.write_text(json.dumps(pointer))
    os.replace(tmp, out_root / "latest.json")  # atomic: viewers flip to the new run at once
    prune(out_root, keep_runs)
    write_run_index(out_root)
    return final


RUN_NAME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}Z_PT\d+H$")


def list_runs(out_root: Path) -> list[str]:
    """Complete runs, oldest first (names sort chronologically)."""
    return sorted(p.name for p in (out_root / "runs").iterdir() if p.is_dir() and RUN_NAME.match(p.name))


def prune(out_root: Path, keep: int):
    for old in list_runs(out_root)[:-keep]:
        shutil.rmtree(out_root / "runs" / old)


def write_run_index(out_root: Path):
    """runs.json: newest first, feeds the viewer's run selector."""
    tmp = out_root / ".runs.json.tmp"
    tmp.write_text(json.dumps({"runs": list_runs(out_root)[::-1]}))
    os.replace(tmp, out_root / "runs.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--synthetic", action="store_true", help="fake ensemble for demos/tests")
    ap.add_argument("--members", nargs="*", type=Path, help="per-member forecast .zarr dirs")
    ap.add_argument("--era5", type=Path, help="ERA5 zarr: publish ground truth as a one-member run")
    ap.add_argument("--start", type=int, default=0, help="first time index for --era5")
    ap.add_argument("--grid", default="181x360", help="synthetic grid HxW (full res: 721x1440)")
    ap.add_argument("--n-members", type=int, default=4)
    ap.add_argument("--n-times", type=int, default=13)
    ap.add_argument("--keep", type=int, default=4)
    ap.add_argument("--point-stride", type=int, default=1,
                    help="store per-point ensembles every N grid cells (2 = 0.5 deg from 0.25 deg)")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    if a.synthetic:
        h, w = map(int, a.grid.split("x"))
        src = SyntheticSource(a.n_members, a.n_times, h, w)
    elif a.era5:
        src = ERA5Source(a.era5, a.start, a.n_times)
    elif a.members:
        src = ZarrSource(a.members)
    else:
        ap.error("pass --synthetic, --era5 or --members")
    build_run(src, a.out, keep_runs=a.keep, point_stride=a.point_stride)


if __name__ == "__main__":
    main()
