// Computes isobars, labels and highs/lows for one pressure frame off the main thread.
import { contourLines, findExtrema, mercator } from './contours.js';

const STRIDE = 2;          // 0.25 deg grid -> 0.5 deg for contouring: smooth enough, 4x cheaper
const LABEL_EVERY = 800;   // Pa: label every 8 hPa
const SPACING = 400;       // Pa: a line every 4 hPa

self.onmessage = ({ data }) => {
  const { id, codes, W, H, range, grid, radiusDeg = 22, minProm = 700 } = data;  // codes: R,G bytes per pixel (16-bit, 0 = missing)
  const [lo, hi] = range;
  const w = Math.floor(W / STRIDE), h = Math.floor((H - 1) / STRIDE) + 1;
  const Wx = w + 1;                                  // one extra column repeating column 0: lines cross the seam
  const v = new Float32Array(Wx * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i <= w; i++) {
      const o = ((j * STRIDE) * W + ((i % w) * STRIDE)) * 2;
      const code = codes[o] * 256 + codes[o + 1];
      v[j * Wx + i] = code === 0 ? NaN : lo + ((code - 1) / 65534) * (hi - lo);
    }
  }
  let mn = Infinity, mx = -Infinity;
  for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; }

  const dlon = (360 / W) * STRIDE, dlat = ((grid.lat[0] - grid.lat[1]) / (H - 1)) * STRIDE;
  const toWorld = (gx, gy) => mercator(grid.lon[0] + gx * dlon, grid.lat[0] - gy * dlat);

  const lines = [], labels = [];
  for (let level = Math.ceil(mn / SPACING) * SPACING; level <= mx; level += SPACING) {
    const labelled = level % LABEL_EVERY === 0, major = level % 2000 === 0;
    for (const g of contourLines(v, Wx, h, level)) {
      const n = g.length / 2, pts = new Float32Array(g.length);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let k = 0; k < n; k++) {
        const [x, y] = toWorld(g[2 * k], g[2 * k + 1]);
        pts[2 * k] = x; pts[2 * k + 1] = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      lines.push({ level, major, pts, bbox: [x0, y0, x1, y1] });
      if (labelled && n >= 24) {
        const copies = n >= 260 ? 3 : n >= 120 ? 2 : 1;         // only long lines get several labels
        for (let c = 0; c < copies; c++) {
          const k = Math.floor(((c + 0.5) / copies) * (n - 1)), a = Math.max(0, k - 2), b = Math.min(n - 1, k + 2);
          let ang = Math.atan2(pts[2 * b + 1] - pts[2 * a + 1], pts[2 * b] - pts[2 * a]);
          if (Math.abs(ang) > Math.PI / 2) ang += ang > 0 ? -Math.PI : Math.PI;   // keep text upright
          labels.push({ x: pts[2 * k], y: pts[2 * k + 1], a: ang, text: String(Math.round(level / 100)), major });
        }
      }
    }
  }

  const vw = new Float32Array(w * h);                // periodic version (no seam column) for the extrema search
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) vw[j * w + i] = v[j * Wx + i];
  const centres = findExtrema(vw, w, h, Math.round(radiusDeg / dlon), minProm)
    .filter((e) => Math.abs(grid.lat[0] - e.j * dlat) < 80)
    .map((e) => ({ type: e.type, value: Math.round(e.value / 100), pos: toWorld(e.i, e.j) }));

  self.postMessage({ id, lines, labels, centres });
};
