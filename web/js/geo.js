// Pure grid/projection helpers shared by the renderer, hover and point lookup.

export function gridIndex(grid, lon, lat) {
  const { width: W, height: H } = grid;
  const [lat0, lat1] = grid.lat, [lon0] = grid.lon;
  const dlon = 360 / W, dlat = (lat0 - lat1) / (H - 1);
  const x = ((Math.round((lon - lon0) / dlon) % W) + W) % W;
  const y = Math.min(H - 1, Math.max(0, Math.round((lat0 - lat) / dlat)));
  return { x, y };
}

export function gridLonLat(grid, x, y) {
  const { width: W, height: H } = grid;
  const [lat0, lat1] = grid.lat, [lon0] = grid.lon;
  return { lon: lon0 + (x * 360) / W, lat: lat0 - (y * (lat0 - lat1)) / (H - 1) };
}

/** Byte range of one grid cell's [M,T] uint16 record in a points file. */
export function pointRange(entry, x, y) {
  const n = entry.members * entry.times * 2;
  const start = (y * entry.width + x) * n;
  return { start, end: start + n - 1, n };
}

export function decodePoint(entry, buf) {
  const q = new Uint16Array(buf);
  const [lo, hi] = entry.range, out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = (q[i] / 65535) * (hi - lo) + lo;
  return out; // layout [member][time]
}

/** Raw value from a (possibly fractional) quantisation code; code 0 is reserved for "missing". */
export function dequant(code, entry) {
  const [lo, hi] = entry.range, top = entry.bits === 16 ? 65535 : 255;
  const v = lo + ((code - 1) / (top - 1)) * (hi - lo);
  return entry.transform === 'sqrt' ? v * v : v;
}

export const toDisplay = (raw, meta) => raw * meta.unit_scale + meta.unit_offset;
