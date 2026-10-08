// Colour-scale legend drawn on a canvas: gradient (over a checkerboard, so transparency is visible),
// major and minor ticks at "nice" values, extend arrows when the data goes beyond the scale,
// the data range, and a marker that follows the cursor.

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Decimals needed to print multiples of `step` exactly (2.5 -> 1, 0.25 -> 2, 10 -> 0). */
export function decimalsFor(step) {
  for (let d = 0; d <= 6; d++) if (Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-7) return d;
  return 6;
}

export function formatTick(v, step) {
  if (Math.abs(v) < step * 1e-9) v = 0;
  return v.toFixed(decimalsFor(step)).replace('-', '−');   // real minus sign
}

/** ~`target` evenly spaced round values covering [lo, hi]; also how many minor ticks fit between majors. */
export function niceTicks(lo, hi, target = 7) {
  const span = hi - lo;
  if (!(span > 0)) return { values: [lo], step: 1, minorDiv: 1 };
  const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw));
  const mant = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw * (1 - 1e-9));
  const step = mant * mag, values = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) values.push(+v.toPrecision(12));
  return { values, step, minorDiv: mant === 2 ? 4 : 5 };
}

const SQRT_PRESETS = [0, 0.05, 0.1, 0.2, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500];
/** Ticks for square-root-spaced scales (rain, humidity): dense at the low end. */
export function sqrtTicks(lo, hi) {
  let values = SQRT_PRESETS.filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9);
  while (values.length > 9) values = values.filter((_, i) => i % 2 === 0 || i === values.length - 1);
  return { values, step: Math.min(...values.slice(1).map((v, i) => v - values[i]), 1), minorDiv: 0 };
}

const css = (n, fallback) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fallback;

/**
 * p: { title, subtitle, cmapFn(t) -> [r,g,b,a], tOf(displayValue) -> position 0..1 on the bar,
 *      ticks: {values, step, minorDiv}, dataRange: [min, max] | null, ends: [lo, hi], cursor: number | null }
 */
export function drawLegend(canvas, p) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const fg = css('--fg', '#e8edf5'), muted = css('--muted', '#8493a8'), line = css('--line-strong', '#3a4760');

  const padX = 22, barX = padX, barW = W - 2 * padX, barY = 50, barH = 18;
  const xOf = (t) => barX + t * barW;

  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = fg; ctx.font = `600 13px Inter, system-ui, sans-serif`;
  ctx.fillText(p.title, 2, 15, W - 4);
  ctx.fillStyle = muted; ctx.font = '11.5px Inter, system-ui, sans-serif';
  ctx.fillText(p.subtitle, 2, 31, W - 4);

  // Gradient over a checkerboard.
  ctx.save();
  ctx.beginPath(); ctx.rect(barX, barY, barW, barH); ctx.clip();
  for (let y = 0; y < barH; y += 6) for (let x = 0; x < barW; x += 6) {
    ctx.fillStyle = ((x + y) / 6) % 2 ? '#1b2335' : '#2a3448';
    ctx.fillRect(barX + x, barY + y, 6, 6);
  }
  for (let x = 0; x < barW; x++) {
    const [r, g, b, a] = p.cmapFn(x / (barW - 1));
    ctx.fillStyle = `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
    ctx.fillRect(barX + x, barY, 1.5, barH);
  }
  ctx.restore();
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  ctx.strokeRect(barX - 0.5, barY - 0.5, barW + 1, barH + 1);

  // Extend arrows: the data goes beyond the colour scale, so the end colour is saturated.
  const arrow = (x, dir, col) => {
    ctx.beginPath();
    ctx.moveTo(x, barY); ctx.lineTo(x + dir * 11, barY + barH / 2); ctx.lineTo(x, barY + barH); ctx.closePath();
    ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = line; ctx.stroke();
  };
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  if (p.dataRange && p.dataRange[0] < p.ends[0]) arrow(barX - 1, -1, rgb(p.cmapFn(0)));
  if (p.dataRange && p.dataRange[1] > p.ends[1]) arrow(barX + barW + 1, 1, rgb(p.cmapFn(1)));

  // Ticks: minor, then major with labels.
  const base = barY + barH;
  ctx.strokeStyle = muted; ctx.fillStyle = fg; ctx.font = `11px ${MONO}`; ctx.textAlign = 'center';
  const { values, step, minorDiv } = p.ticks;
  if (minorDiv > 1) {
    ctx.lineWidth = 1; ctx.beginPath();
    const sub = step / minorDiv;
    for (let v = Math.ceil((p.ends[0] - 1e-9) / sub) * sub; v <= p.ends[1] + 1e-9; v += sub) {
      const t = p.tOf(v);
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      const x = Math.round(xOf(t)) + 0.5;
      ctx.moveTo(x, base + 1); ctx.lineTo(x, base + 4);
    }
    ctx.stroke();
  }
  ctx.lineWidth = 1; ctx.beginPath();
  for (const v of values) {
    const t = p.tOf(v);
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const x = Math.round(xOf(t)) + 0.5;
    ctx.moveTo(x, base + 1); ctx.lineTo(x, base + 8);
  }
  ctx.stroke();
  let lastRight = -Infinity;
  for (const v of values) {
    const t = p.tOf(v);
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const label = formatTick(v, step), w = ctx.measureText(label).width;
    let x = xOf(t);
    x = Math.max(w / 2, Math.min(W - w / 2, x));
    if (x - w / 2 < lastRight + 6) continue;            // skip a label rather than overlap
    ctx.fillText(label, x, base + 21);
    lastRight = x + w / 2;
  }

  // Data range over all lead times.
  ctx.textAlign = 'left'; ctx.fillStyle = muted; ctx.font = `10.5px ${MONO}`;
  if (p.dataRange) {
    const f = (v) => formatTick(v, Math.max(step / 10, 1e-6)).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m));
    ctx.fillText(`data  ${f(p.dataRange[0])} … ${f(p.dataRange[1])}`, 2, H - 4);
  }
  ctx.textAlign = 'right'; ctx.fillText(p.unit, W - 2, H - 4);

  // Cursor marker: line across the bar, triangle above it.
  if (p.cursor != null && Number.isFinite(p.cursor)) {
    const t = Math.max(0, Math.min(1, p.tOf(p.cursor))), x = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, barY - 2); ctx.lineTo(x, barY + barH + 2); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath();
    ctx.moveTo(x - 5, barY - 9); ctx.lineTo(x + 5, barY - 9); ctx.lineTo(x, barY - 2); ctx.closePath(); ctx.fill();
  }
}
