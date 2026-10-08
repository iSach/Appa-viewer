import { niceTicks, formatTick, sqrtTicks, decimalsFor } from '../../web/js/legend.js';
const t = (lo, hi, n) => { const r = niceTicks(lo, hi, n); return { v: r.values, step: r.step, labels: r.values.map((x) => formatTick(x, r.step)), minorDiv: r.minorDiv }; };
console.log(JSON.stringify({
  temp: t(-66.1, 42.0, 7), rain: t(0, 5.5, 7), pressure: t(950, 1037.5, 7), prob: t(0, 100, 7), small: t(0.0, 0.3, 6),
  decimals: [decimalsFor(2.5), decimalsFor(0.25), decimalsFor(10), decimalsFor(0.1)],
  sqrt: sqrtTicks(0, 5.5).values, sqrtBig: sqrtTicks(0, 120).values,
  neg0: formatTick(-1e-12, 5), minus: formatTick(-12.5, 2.5),
}));
