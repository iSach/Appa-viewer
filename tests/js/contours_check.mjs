// Known-answer checks for the contouring code; prints JSON for pytest.
import { contourLines, findExtrema, mercator } from '../../web/js/contours.js';

const out = {};

// 1) Radial field: the level-R isoline is a circle of radius R around the centre.
{
  const W = 81, H = 61, cx = 40.3, cy = 30.1, R = 17;
  const v = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) v[j * W + i] = Math.hypot(i - cx, j - cy);
  const lines = contourLines(v, W, H, R);
  const radii = lines.flatMap((l) => Array.from({ length: l.length / 2 }, (_, k) => Math.hypot(l[2 * k] - cx, l[2 * k + 1] - cy)));
  const first = lines[0];
  out.circle = {
    nLines: lines.length, nPts: radii.length,
    maxRadiusError: Math.max(...radii.map((r) => Math.abs(r - R))),
    closed: first[0] === first[first.length - 2] && first[1] === first[first.length - 1],
  };
}

// 2) Linear ramp: one open line per level, straight and at the right x.
{
  const W = 30, H = 20, v = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) v[j * W + i] = i * 2;
  const lines = contourLines(v, W, H, 21);  // x = 10.5
  out.ramp = { nLines: lines.length, xs: Array.from(new Set(Array.from(lines[0]).filter((_, k) => k % 2 === 0))), nPts: lines[0].length / 2 };
}

// 3) Saddle: two highs on a diagonal; the isoline must not cross itself (2 lines, not 1 tangled).
{
  const W = 21, H = 21, v = new Float32Array(W * H);
  const g = (i, j, a, b) => Math.exp(-((i - a) ** 2 + (j - b) ** 2) / 12);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) v[j * W + i] = g(i, j, 6, 6) + g(i, j, 14, 14);
  out.saddle = { nLines: contourLines(v, W, H, 0.3).length };
}

// 4) NaN cells are skipped without crashing and produce no line through them.
{
  const W = 10, H = 10, v = new Float32Array(W * H).map((_, k) => (k % W));
  for (let j = 0; j < H; j++) v[j * W + 5] = NaN;
  out.nan = { nLines: contourLines(v, W, H, 2.5).length, nLinesThroughHole: contourLines(v, W, H, 5.5).length };
}

// 5) Highs/lows, including one that straddles the longitude seam (column 0 / W-1).
{
  const W = 120, H = 61, v = new Float32Array(W * H).fill(1013);
  const bump = (ci, cj, amp) => { for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const di = Math.min(Math.abs(i - ci), W - Math.abs(i - ci)), dj = j - cj;
    v[j * W + i] += amp * Math.exp(-(di * di + dj * dj) / 40); } };
  bump(118, 20, 18);   // high near the seam (i = 118, wraps past 119 -> 0)
  bump(60, 40, -30);   // deep low
  const ex = findExtrema(v, W, H, 10, 3);
  out.extrema = ex.map((e) => ({ type: e.type, i: e.i, j: e.j, value: Math.round(e.value) })).sort((a, b) => a.type.localeCompare(b.type));
}

// 6) Mercator: equator at y = 0.5, lon 0 at x = 0.5, clamped at the map limit.
out.mercator = [mercator(0, 0), mercator(-180, 85.0511287798), mercator(180, 89.9)];

console.log(JSON.stringify(out));
