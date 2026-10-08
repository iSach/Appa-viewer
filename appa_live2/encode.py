"""Quantise float fields and pack them as lossless PNG frames.

The browser decodes a frame with createImageBitmap and uploads it as a texture:
8-bit fields live in the R channel, 16-bit fields in R (high byte) and
G (low byte). Frames of one field are concatenated into a single .pack file;
the manifest lists (offset, length) of each frame so the viewer can fetch any
frame with an HTTP Range request. This keeps the file count tiny.
"""
import io
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image


def forward(x: np.ndarray, transform: str) -> np.ndarray:
    if transform == "sqrt":
        return np.sqrt(np.maximum(x, 0.0))
    return x


def inverse(x: np.ndarray, transform: str) -> np.ndarray:
    if transform == "sqrt":
        return x * x
    return x


def full_range(frames: np.ndarray, transform: str) -> tuple[float, float]:
    """True (min, max) of the finite values in transformed space: nothing is
    clipped, so hover values stay correct even for extreme events."""
    t = forward(np.asarray(frames, dtype=np.float32), transform)
    t = t[np.isfinite(t)]
    if t.size == 0:
        return 0.0, 1.0
    lo, hi = float(t.min()), float(t.max())
    if hi - lo < 1e-12:
        hi = lo + 1.0
    return lo, hi


def display_range(frames: np.ndarray, lo_q=0.001, hi_q=0.999) -> tuple[float, float]:
    """Robust colour-scale limits in raw units (outliers don't wash out the map).
    Subsamples so huge arrays stay cheap; ignores missing values."""
    t = np.asarray(frames, dtype=np.float32).ravel()
    if t.size > 4_000_000:
        t = t[:: t.size // 4_000_000]
    t = t[np.isfinite(t)]
    if t.size == 0:
        return 0.0, 1.0
    lo, hi = np.quantile(t, [lo_q, hi_q])
    if hi - lo < 1e-12:
        hi = lo + 1.0
    return float(lo), float(hi)


def quantize(x: np.ndarray, lo: float, hi: float, bits: int, transform: str = "linear") -> np.ndarray:
    """Code 0 means "missing" (NaN, e.g. sea surface temperature over land);
    values map to codes 1..top."""
    top = (1 << bits) - 1
    with np.errstate(invalid="ignore"):
        t = (forward(x, transform) - lo) / (hi - lo)
        q = 1.0 + np.rint(np.clip(t, 0.0, 1.0) * (top - 1))
    q = np.where(np.isfinite(x), np.nan_to_num(q), 0.0)
    return q.astype(np.uint8 if bits == 8 else np.uint16)


def dequantize(q: np.ndarray, lo: float, hi: float, bits: int, transform: str = "linear") -> np.ndarray:
    top = (1 << bits) - 1
    v = inverse((q.astype(np.float32) - 1.0) / (top - 1) * (hi - lo) + lo, transform)
    return np.where(q == 0, np.float32(np.nan), v).astype(np.float32)


def png_bytes(q: np.ndarray, bits: int) -> bytes:
    if bits == 8:
        img = Image.fromarray(q, "L")
    else:
        rgb = np.zeros(q.shape + (3,), np.uint8)
        rgb[..., 0] = q >> 8
        rgb[..., 1] = q & 0xFF
        img = Image.fromarray(rgb, "RGB")
    buf = io.BytesIO()
    img.save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def decode_png(blob: bytes, bits: int) -> np.ndarray:
    """Reference decoder (what the viewer's shader does), used by tests."""
    img = Image.open(io.BytesIO(blob))
    a = np.asarray(img)
    if bits == 8:
        return a
    return (a[..., 0].astype(np.uint16) << 8) | a[..., 1]


def wind_png_bytes(u: np.ndarray, v: np.ndarray, vmax: float) -> bytes:
    """u in R, v in G, both mapped from [-vmax, vmax] to 0..255."""
    rgb = np.zeros(u.shape + (3,), np.uint8)
    rgb[..., 0] = np.rint(np.clip(u / vmax * 0.5 + 0.5, 0, 1) * 255)
    rgb[..., 1] = np.rint(np.clip(v / vmax * 0.5 + 0.5, 0, 1) * 255)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def encode_frames(frames: np.ndarray, lo: float, hi: float, bits: int, transform: str,
                  workers: int = 8) -> list[bytes]:
    """frames: [T, H, W] float -> list of PNG blobs (zlib releases the GIL)."""
    with ThreadPoolExecutor(workers) as pool:
        return list(pool.map(lambda f: png_bytes(quantize(f, lo, hi, bits, transform), bits), frames))


def write_pack(path, blobs: list[bytes]) -> list[list[int]]:
    """Concatenate blobs into one file, return [[offset, length], ...]."""
    index, pos = [], 0
    with open(path, "wb") as f:
        for b in blobs:
            f.write(b)
            index.append([pos, len(b)])
            pos += len(b)
    return index
