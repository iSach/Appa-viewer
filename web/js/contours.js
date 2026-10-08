// Pure contouring helpers (no DOM): marching squares with chaining into polylines,
// and detection of pressure highs/lows. Used from a Web Worker and from node tests.

/**
 * Isolines of `v` (row-major, W x H, NaN = missing) at `level`.
 * Returns polylines as Float32Array [x0, y0, x1, y1, ...] in fractional grid coordinates.
 * Crossings sit on cell edges, identified by integer keys so neighbouring cells join exactly.
 */
export function contourLines(v, W, H, level) {
  const hKey = (i, j) => 2 * (j * W + i);       // edge (i,j)-(i+1,j)
  const vKey = (i, j) => 2 * (j * W + i) + 1;   // edge (i,j)-(i,j+1)
  const adj = new Map();
  const link = (a, b) => {
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  };

  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const tl = v[j * W + i], tr = v[j * W + i + 1], bl = v[(j + 1) * W + i], br = v[(j + 1) * W + i + 1];
      if (tl !== tl || tr !== tr || bl !== bl || br !== br) continue; // NaN
      const mn = Math.min(tl, tr, bl, br), mx = Math.max(tl, tr, bl, br);
      if (level > mx || level <= mn) continue;
      const idx = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      const top = hKey(i, j), bottom = hKey(i, j + 1), left = vKey(i, j), right = vKey(i + 1, j);
      switch (idx) {
        case 1: case 14: link(left, bottom); break;
        case 2: case 13: link(bottom, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, top); break;
        case 5: case 10: {
          // Saddle: the cell centre decides which pair of corners is connected.
          const centreHigh = (tl + tr + bl + br) / 4 >= level;
          if ((idx === 5) === centreHigh) { link(left, top); link(bottom, right); }
          else { link(top, right); link(left, bottom); }
          break;
        }
        default: break;
      }
    }
  }

  const point = (key) => {
    const e = key >> 1, i = e % W, j = (e - i) / W;
    if (key & 1) { const a = v[j * W + i], b = v[(j + 1) * W + i]; return [i, j + (level - a) / (b - a)]; }
    const a = v[j * W + i], b = v[j * W + i + 1];
    return [i + (level - a) / (b - a), j];
  };

  const seen = new Set(), lines = [];
  const walk = (start) => {
    const pts = [];
    let prev = -1, cur = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      pts.push(...point(cur));
      const next = adj.get(cur).find((k) => k !== prev && !seen.has(k));
      prev = cur; cur = next;
    }
    if (adj.get(start).length === 2) pts.push(pts[0], pts[1]); // closed loop: join the ends
    if (pts.length >= 4) lines.push(Float32Array.from(pts));
  };
  for (const [key, nb] of adj) if (nb.length === 1 && !seen.has(key)) walk(key); // open lines first
  for (const key of adj.keys()) if (!seen.has(key)) walk(key);                    // then closed loops
  return lines;
}

/**
 * Pressure highs and lows: cells that are the extreme of their (2r+1)^2 neighbourhood
 * AND differ from its mean by at least `minProm`. Longitude wraps; latitude is clamped.
 * Returns [{type: 'H'|'L', i, j, value}] with duplicates (same type, within r cells) removed.
 */
export function findExtrema(v, W, H, r, minProm) {
  const n = W * H;
  const hmax = new Float32Array(n), hmin = new Float32Array(n), hsum = new Float32Array(n);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let mx = -Infinity, mn = Infinity, s = 0, c = 0;
      for (let d = -r; d <= r; d++) {
        const x = v[j * W + ((i + d + W) % W)];
        if (x !== x) continue;
        if (x > mx) mx = x; if (x < mn) mn = x; s += x; c++;
      }
      hmax[j * W + i] = mx; hmin[j * W + i] = mn; hsum[j * W + i] = c ? s / c : NaN;
    }
  }
  const cand = [];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = v[j * W + i];
      if (x !== x) continue;
      let mx = -Infinity, mn = Infinity, s = 0;
      for (let d = -r; d <= r; d++) {
        const jj = Math.min(H - 1, Math.max(0, j + d)), k = jj * W + i;
        if (hmax[k] > mx) mx = hmax[k]; if (hmin[k] < mn) mn = hmin[k]; s += hsum[k];
      }
      const mean = s / (2 * r + 1), prom = x - mean;
      if (x === mx && prom >= minProm) cand.push({ type: 'H', i, j, value: x, prom });
      else if (x === mn && -prom >= minProm) cand.push({ type: 'L', i, j, value: x, prom: -prom });
    }
  }
  cand.sort((a, b) => b.prom - a.prom);
  const out = [];
  for (const c of cand) {
    const near = out.some((o) => o.type === c.type && Math.abs(o.j - c.j) <= r &&
      Math.min(Math.abs(o.i - c.i), W - Math.abs(o.i - c.i)) <= r);
    if (!near) out.push(c);
  }
  return out.map(({ type, i, j, value }) => ({ type, i, j, value }));
}

/** Web Mercator world coordinates ([0,1], y down) of lon/lat degrees; latitude clamped to the map's limit. */
export function mercator(lon, lat) {
  const phi = (Math.max(-85.0511287798, Math.min(85.0511287798, lat)) * Math.PI) / 180;
  return [(lon + 180) / 360, 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)];
}
