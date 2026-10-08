// Colormaps as 256x1 RGBA lookup tables (straight alpha). Stops are hex, optionally
// with an alpha byte (#rrggbbaa) so precipitation/probability fade to transparent.

const STOPS = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  plasma: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  magma: ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fecf92', '#fcfdbf'],
  spread: ['#0b0b2a00', '#2a1a63', '#6a2c91', '#b73779', '#f7705c', '#fecf92', '#fcfdbf'],
  pressure: ['#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b'],
  humidity: ['#543005', '#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#f5f5f5', '#c7eae5', '#80cdc1', '#35978f', '#01665e', '#003c30'],
  wind: ['#1b2a5c', '#2b5aa8', '#2fa4d9', '#3fc9a2', '#8fe05a', '#e6e34a', '#f6a73a', '#ef6a2f', '#d32f3a', '#8b1a63'],
  rain: ['#5aa6ff00', '#5aa6ffb0', '#2f6bff', '#19c37d', '#f1e03a', '#f58a1f', '#e0282e', '#b01d9b'],
  prob: ['#ffffb200', '#fed97699', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026', '#7a0177'],
};

export const COLORMAP_NAMES = ['turbo', ...Object.keys(STOPS)];

// Google's polynomial approximation of the Turbo colormap (Mikhailov, 2019).
export function turbo(x) {
  x = Math.min(1, Math.max(0, x));
  const x2 = x * x, x3 = x2 * x, x4 = x2 * x2, x5 = x4 * x;
  const r = 0.13572138 + 4.61539260 * x - 42.66032258 * x2 + 132.13108234 * x3 - 152.94239396 * x4 + 59.28637943 * x5;
  const g = 0.09140261 + 2.19418839 * x + 4.84296658 * x2 - 14.18503333 * x3 + 4.27729857 * x4 + 2.82956604 * x5;
  const b = 0.10667330 + 12.64194608 * x - 60.58204836 * x2 + 110.36276771 * x3 - 89.90310912 * x4 + 27.34824973 * x5;
  const c = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return [c(r), c(g), c(b), 255];
}

function parseHex(h) {
  const n = h.replace('#', '');
  const v = (i) => parseInt(n.slice(i, i + 2), 16);
  return [v(0), v(2), v(4), n.length >= 8 ? v(6) : 255];
}

function fromStops(stops) {
  const cols = stops.map(parseHex);
  return (x) => {
    const p = Math.min(1, Math.max(0, x)) * (cols.length - 1);
    const i = Math.min(cols.length - 2, Math.floor(p)), f = p - i;
    return cols[i].map((c, k) => Math.round(c + (cols[i + 1][k] - c) * f));
  };
}

export function colormapFn(name) {
  if (name === 'turbo') return turbo;
  return fromStops(STOPS[name] || STOPS.viridis);
}

/** 256*4 bytes, ready for gl.texImage2D(width=256, height=1). */
export function lut(name) {
  const f = colormapFn(name), out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) out.set(f(i / 255), i * 4);
  return out;
}

/** CSS gradient for the legend (opaque preview over the dark panel). */
export function cssGradient(name, n = 12) {
  const f = colormapFn(name);
  const s = [];
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = f(i / (n - 1));
    s.push(`rgba(${r},${g},${b},${(a / 255).toFixed(2)}) ${((i / (n - 1)) * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${s.join(',')})`;
}
