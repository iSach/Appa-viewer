// Tiny canvas line charts: ensemble plume and verification curves.

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function setup(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/**
 * series: [{ y: number[], color, width, alpha }], band: {lo: number[], hi: number[]} | null,
 * x: number[] (hours). Y range is fitted to everything drawn.
 */
export function lineChart(canvas, { x, series, band = null, yUnit = '', xUnit = 'h', zeroBased = false }) {
  const { ctx, w, h } = setup(canvas);
  const m = { l: 40, r: 8, t: 8, b: 20 };
  const all = series.flatMap((s) => s.y).concat(band ? band.lo.concat(band.hi) : []).filter(Number.isFinite);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (zeroBased) lo = Math.min(0, lo);
  const pad = (hi - lo || 1) * 0.08; hi += pad; if (!zeroBased || lo < 0) lo -= pad;
  const X = (v) => m.l + ((v - x[0]) / (x[x.length - 1] - x[0] || 1)) * (w - m.l - m.r);
  const Y = (v) => h - m.b - ((v - lo) / (hi - lo)) * (h - m.t - m.b);

  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = css('--grid'); ctx.fillStyle = css('--muted'); ctx.lineWidth = 1;
  for (const t of niceTicks(lo, hi)) {
    ctx.beginPath(); ctx.moveTo(m.l, Y(t)); ctx.lineTo(w - m.r, Y(t)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(Number(t.toPrecision(4)).toString(), m.l - 4, Y(t));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const step = Math.max(1, Math.ceil(x.length / 6));
  x.forEach((v, i) => { if (i % step === 0) ctx.fillText(`+${v}${xUnit}`, X(v), h - 5); });

  if (band) {
    ctx.fillStyle = css('--band');
    ctx.beginPath();
    x.forEach((v, i) => (i ? ctx.lineTo(X(v), Y(band.hi[i])) : ctx.moveTo(X(v), Y(band.hi[i]))));
    for (let i = x.length - 1; i >= 0; i--) ctx.lineTo(X(x[i]), Y(band.lo[i]));
    ctx.closePath(); ctx.fill();
  }
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1; ctx.globalAlpha = s.alpha ?? 1;
    ctx.beginPath();
    s.y.forEach((v, i) => (i ? ctx.lineTo(X(x[i]), Y(v)) : ctx.moveTo(X(x[i]), Y(v))));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (yUnit) { ctx.fillStyle = css('--muted'); ctx.textAlign = 'left'; ctx.fillText(yUnit, 4, 8); }
}

/** rec: Float32Array [member][time] in raw units. */
export function plume(canvas, rec, M, T, leadHours, meta) {
  const conv = (v) => v * meta.unit_scale + meta.unit_offset;
  const members = [];
  for (let m = 0; m < M; m++) members.push(Array.from(rec.subarray(m * T, (m + 1) * T), conv));
  const col = (i) => members.map((r) => r[i]);
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); const k = p * (s.length - 1); const f = Math.floor(k); return s[f] + (s[Math.min(f + 1, s.length - 1)] - s[f]) * (k - f); };
  const mean = Array.from({ length: T }, (_, i) => col(i).reduce((a, b) => a + b, 0) / M);
  const band = M >= 5 ? { lo: Array.from({ length: T }, (_, i) => q(col(i), 0.1)), hi: Array.from({ length: T }, (_, i) => q(col(i), 0.9)) } : null;
  const series = members.map((y) => ({ y, color: css('--member'), width: 1, alpha: 0.6 }));
  series.push({ y: mean, color: css('--fg'), width: 2 });
  lineChart(canvas, { x: leadHours, series, band, yUnit: meta.unit, zeroBased: meta.unit === 'mm/h' });
}
