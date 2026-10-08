"""Per-gridpoint ensemble time series, readable with a single HTTP Range request.

File layout (little-endian uint16): [H, W, M, T]. All members and lead times of
one grid cell are contiguous, so the browser fetches the record of a clicked
point with `Range: bytes=off-(off+M*T*2-1)`, no server code involved. The same
files later serve as the ensemble when verifying against analysis.
"""
import numpy as np
import torch


def write_points(path, members: torch.Tensor, stride: int = 1, rows_per_block: int = 64) -> dict:
    """members: [M, T, H, W] float tensor. Returns the manifest entry.

    stride > 1 stores every stride-th row/column (e.g. 2 -> 0.5 degrees from a
    0.25 degree grid): file size is H*W*M*T*2 bytes / stride^2.
    """
    M, T, H, W = members.shape
    if stride > 1:
        if (H - 1) % stride or W % stride:
            raise ValueError(f"grid {H}x{W} is not divisible by stride {stride}")
        members = members[:, :, ::stride, ::stride]
        H, W = members.shape[2:]
    if not torch.isfinite(members).all():
        raise ValueError("point fields must not contain NaN/inf (missing values are not supported here)")
    lo, hi = float(members.min()), float(members.max())
    if hi - lo < 1e-12:
        hi = lo + 1.0
    scale = 65535.0 / (hi - lo)
    with open(path, "wb") as f:
        for r0 in range(0, H, rows_per_block):
            blk = members[:, :, r0:r0 + rows_per_block, :]
            q = ((blk - lo) * scale).round().clamp_(0, 65535).to(torch.int32)
            # [M,T,h,W] -> [h,W,M,T]
            q = q.permute(2, 3, 0, 1).contiguous().cpu().numpy().astype("<u2")
            f.write(q.tobytes())
    return {"file": str(path), "range": [lo, hi], "members": M, "times": T, "height": H, "width": W,
            "stride": stride}


def read_point(path, entry: dict, y: int, x: int) -> np.ndarray:
    """Reference reader: -> float32 [M, T] (what the browser does)."""
    M, T, W = entry["members"], entry["times"], entry["width"]
    n = M * T
    with open(path, "rb") as f:
        f.seek(((y * W) + x) * n * 2)
        q = np.frombuffer(f.read(n * 2), dtype="<u2").reshape(M, T)
    lo, hi = entry["range"]
    return q.astype(np.float32) / 65535.0 * (hi - lo) + lo
