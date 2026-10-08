import { COLORMAP_NAMES, cssGradient } from './colormaps.js';
import { FramePack, fetchPoint, getJSON, loadRun } from './data.js';
import { FieldGL } from './fieldgl.js';
import { dequant, gridIndex } from './geo.js';
import { WindParticles } from './wind.js';
import { Overlay } from './overlay.js';
import { lineChart, plume } from './chart.js';

const $ = (id) => document.getElementById(id);
const MAX_LAT = 85.0511287798;
const FPS_FRAMES = 3; // forecast frames per second while playing

const S = {
  manifest: null, runs: [], variable: '2m_temperature', level: 500, product: 'mean',
  t: 0, playing: false, wind: true, iso: true,
  pack: null, windPack: null, textures: new Map(), dirty: true, marker: null, points: null,
  cmap: null, ranges: {}, cursor: null,
  isoPack: null, isoFrame: -1, isoBusy: false, isoRequested: -1,
};

let map, fieldGL, particles, overlay, worker, lastTs = 0;

// ---------- helpers ----------
const fieldId = (v, l) => (l == null ? v : `${v}_${l}`);
const varMeta = () => S.manifest.variables[S.variable];
const hasLevels = () => varMeta().levels != null;
const curId = () => fieldId(S.variable, hasLevels() ? S.level : null);
const curEntry = () => S.manifest.fields[S.product]?.[curId()];
const T = () => S.manifest.valid_times.length;

/** Display conversion: statistics of a variable are not all in the variable's units. */
function conv() {
  const m = varMeta();
  if (S.product.startsWith('prob')) return { scale: 100, offset: 0, unit: '%' };
  if (S.product === 'std') return { scale: m.unit_scale, offset: 0, unit: m.unit };
  return { scale: m.unit_scale, offset: m.unit_offset, unit: m.unit };
}
const show = (raw) => raw * conv().scale + conv().offset;
const rangeKey = () => `${S.product}:${curId()}`;
const dispRange = () => S.ranges[rangeKey()] || curEntry().display_range;
const defaultCmap = () => S.manifest.products[S.product].colormap || varMeta().colormap;
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

function toast(msg, action) {
  const el = $('toast');
  el.replaceChildren(Object.assign(document.createElement('span'), { textContent: msg }));
  if (action) {
    const b = Object.assign(document.createElement('button'), { textContent: action.label, type: 'button' });
    b.onclick = () => { el.hidden = true; action.fn(); };
    el.append(b);
  }
  el.hidden = false;
}

// ---------- map ----------
function initMap() {
  // Bundled Natural Earth lines (public domain): no tile service, no API key, works offline.
  // The map canvas is transparent: the data canvas sits underneath it, borders are drawn on top.
  const geo = (name) => ({ type: 'geojson', data: new URL(`vendor/${name}.json`, location.href).href });
  map = new maplibregl.Map({
    container: 'map', center: [10, 25], zoom: 1.6, minZoom: 0.8, maxZoom: 7, renderWorldCopies: true,
    maxPitch: 0, dragRotate: false, pitchWithRotate: false,
    attributionControl: { compact: true, customAttribution: 'Natural Earth' },
    style: {
      version: 8,
      sources: { borders: geo('borders'), coast: geo('coast') },
      layers: [
        { id: 'borders', type: 'line', source: 'borders',
          paint: { 'line-color': 'rgba(255,255,255,0.30)', 'line-width': 0.6 } },
        { id: 'coast', type: 'line', source: 'coast',
          paint: { 'line-color': 'rgba(255,255,255,0.6)', 'line-width': 0.9 } },
      ],
    },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  return new Promise((res) => map.on('load', res));
}

function initFieldLayer() {
  fieldGL = new FieldGL($('field'));
  fieldGL.opacity = 0.95;
  const fit = () => {
    const r = map.getContainer().getBoundingClientRect();
    fieldGL.resize(r.width, r.height, Math.min(window.devicePixelRatio || 1, 2));
    S.dirty = true;
  };
  fit();
  map.on('resize', fit);
  // Redraw in step with every camera change so data and borders never drift apart.
  map.on('move', () => { if (S.manifest) draw(); });
  window.appa = { S, map, fieldGL }; // handy in the browser console
}

function viewState() {
  const c = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter());
  return { center: [c.x, c.y], world: 512 * 2 ** map.getZoom() };
}

// ---------- field loading ----------
function clearTextures() {
  for (const t of S.textures.values()) fieldGL.deleteTexture(t);
  S.textures.clear();
}

function loadField() {
  const entry = curEntry();
  S.pack?.destroy();
  clearTextures();
  if (!entry) { S.pack = null; S.dirty = true; return; }
  S.pack = new FramePack(S.manifest.base, entry, {
    concurrency: 3,
    onFrame: (i, bmp) => { S.textures.set(i, fieldGL.makeTexture(bmp)); S.dirty = true; },
    onError: (i, err) => { console.error('frame', i, err); toast(`Could not load ${curId()} frame ${i}: ${err.message}`); },
  });
  S.pack.prefetchFrom(Math.round(S.t));
  fieldGL.setColormap(S.cmap || defaultCmap());
  updateLegend();
  S.dirty = true;
}

function loadWind() {
  S.windPack?.destroy();
  S.windPack = null;
  const key = hasLevels() ? String(S.level) : '10m';
  const entry = S.manifest.wind[key];
  if (!entry) return;
  S.windPack = new FramePack(S.manifest.base, entry, { concurrency: 2 });
  S.windPack.prefetchFrom(Math.round(S.t));
}

/** Display value at fraction t of the colour scale (sqrt-spaced for fields coloured in sqrt space). */
function legendValue(t) {
  const [lo, hi] = dispRange(), sq = curEntry().transform === 'sqrt';
  if (!sq) return show(lo + t * (hi - lo));
  const s0 = Math.sqrt(Math.max(lo, 0));
  return show((s0 + t * (Math.sqrt(hi) - s0)) ** 2);
}

function updateLegend() {
  const entry = curEntry(), c = conv(), m = varMeta();
  if (!entry) return;
  $('legend-title').textContent = `${m.label}${hasLevels() ? ` · ${S.level} hPa` : ''} — ${S.manifest.products[S.product].label}`;
  $('legend-bar').style.backgroundImage = cssGradient(S.cmap || defaultCmap());
  $('legend-scale').replaceChildren(...[0, 0.25, 0.5, 0.75, 1].map((t) =>
    Object.assign(document.createElement('span'), { textContent: fmt(legendValue(t)) })));
  $('legend-unit').textContent = c.unit;
  const [lo, hi] = dispRange();
  $('in-min').value = Number(show(lo).toFixed(2));
  $('in-max').value = Number(show(hi).toFixed(2));
}

// ---------- rendering ----------
function nearestLoaded(i) {
  if (S.textures.has(i)) return i;
  let best = null;
  for (const k of S.textures.keys()) if (best === null || Math.abs(k - i) < Math.abs(best - i)) best = k;
  return best;
}

function draw() {
  const entry = curEntry();
  if (!entry || !S.pack) { fieldGL.draw({ entry: { range: [0, 1], bits: 8 }, grid: S.manifest.grid }, null, null, 0, [0, 1], viewState()); return; }
  const i0 = Math.min(Math.floor(S.t), T() - 1), i1 = Math.min(i0 + 1, T() - 1), f = S.t - i0;
  const a = nearestLoaded(i0), b = S.textures.has(i1) ? i1 : null;
  const field = { entry, grid: S.manifest.grid, transparentBelow: transparentBelowRaw() };
  fieldGL.draw(field, S.textures.get(a), b !== null && a === i0 ? S.textures.get(b) : null, f, dispRange(), viewState());
}

function transparentBelowRaw() {
  // Fade out "no rain"-type pixels for value statistics only (not spread or probabilities).
  const isValueStat = S.product === 'mean' || /^p\d+$/.test(S.product);
  return isValueStat ? varMeta().transparent_below : null;
}

function updateWind() {
  if (!particles) return;
  const ok = S.wind && S.windPack;
  particles.setEnabled(!!ok);
  if (!ok) return;
  const i0 = Math.min(Math.floor(S.t), T() - 1), i1 = Math.min(i0 + 1, T() - 1);
  const a = S.windPack.pixels(i0, 2) || S.windPack.pixels(nearestWindFrame(i0), 2);
  const b = S.windPack.pixels(i1, 2);
  if (!a) { S.windPack.frame(i0).then(() => {}).catch(() => {}); return; }
  particles.setWind(S.manifest.grid, S.windPack.entry.vmax, a, b, S.t - i0);
}
function nearestWindFrame(i) {
  let best = null;
  for (const k of S.windPack.bitmaps.keys()) if (best === null || Math.abs(k - i) < Math.abs(best - i)) best = k;
  return best ?? i;
}

function timeLabel() {
  const m = S.manifest, i0 = Math.min(Math.floor(S.t), T() - 1), i1 = Math.min(i0 + 1, T() - 1), f = S.t - i0;
  const lead = m.lead_hours[i0] + (m.lead_hours[i1] - m.lead_hours[i0]) * f;
  const ms = Date.parse(m.valid_times[i0]) + (Date.parse(m.valid_times[i1]) - Date.parse(m.valid_times[i0])) * f;
  const d = new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const loaded = S.pack ? S.pack.bitmaps.size : 0;
  const status = S.pack && loaded < T() ? `  ·  loading ${loaded}/${T()}` : '';
  $('time-label').textContent = `${d} UTC  ·  +${lead.toFixed(lead % 1 ? 1 : 0)} h${status}`;
}

function loop(ts) {
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (S.playing && T() > 1) {
    S.t += dt * FPS_FRAMES;
    if (S.t >= T() - 1) S.t = 0;
    S.dirty = true;
  }
  if (S.dirty) {
    S.dirty = false;
    $('slider').value = Math.round(S.t * 100);
    timeLabel();
    draw();
    updateWind();
    requestContours();
    if (S.cursor) updateReadout(S.cursor);
  } else if (S.wind && S.windPack) {
    updateWind();
  }
  particles?.tick(dt || 1 / 60);
  requestAnimationFrame(loop);
}

// ---------- hover / readout ----------
/** Raw (model-unit) value of a quantised pack at a position, time-interpolated; null when missing/not loaded. */
function sampleRaw(pack, entry, lngLat) {
  if (!pack || !entry) return null;
  const ch = entry.bits === 16 ? 2 : 1;
  const { x, y } = gridIndex(S.manifest.grid, lngLat.lng, lngLat.lat);
  const W = S.manifest.grid.width;
  const get = (i) => {
    const px = pack.pixels(i, ch);
    if (!px) return null;
    const o = (y * W + x) * ch;
    return ch === 2 ? px[o] * 256 + px[o + 1] : px[o]; // quantisation code, 0 = missing
  };
  const i0 = Math.min(Math.floor(S.t), T() - 1), i1 = Math.min(i0 + 1, T() - 1), f = S.t - i0;
  const a = get(i0), b = get(i1);
  if (a == null || a === 0) return null;
  const code = b == null || b === 0 ? a : a + (b - a) * f;
  return dequant(code, entry);
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Wind (speed m/s, meteorological direction in degrees = where it blows FROM) from the wind pack. */
function sampleWind(lngLat) {
  const pack = S.windPack;
  if (!pack) return null;
  const { x, y } = gridIndex(S.manifest.grid, lngLat.lng, lngLat.lat), W = S.manifest.grid.width;
  const i0 = Math.min(Math.floor(S.t), T() - 1), i1 = Math.min(i0 + 1, T() - 1), f = S.t - i0;
  const a = pack.pixels(i0, 2), b = pack.pixels(i1, 2) || a;
  if (!a) return null;
  const o = (y * W + x) * 2, vmax = pack.entry.vmax;
  const dec = (c) => (c / 255 - 0.5) * 2 * vmax;
  const u = dec(a[o] + (b[o] - a[o]) * f), v = dec(a[o + 1] + (b[o + 1] - a[o + 1]) * f);
  const dir = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  return { speed: Math.hypot(u, v), dir };
}

const fmtLat = (v) => `${Math.abs(v).toFixed(2).padStart(5)}°${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => { const l = ((((v + 180) % 360) + 360) % 360) - 180; return `${Math.abs(l).toFixed(2).padStart(6)}°${l >= 0 ? 'E' : 'W'}`; };

function updateReadout(lngLat) {
  const el = $('readout');
  if (!lngLat || Math.abs(lngLat.lat) > MAX_LAT) { el.textContent = '—'; return; }
  const rows = [`${fmtLat(lngLat.lat)}  ${fmtLon(lngLat.lng)}`];
  const raw = sampleRaw(S.pack, curEntry(), lngLat);
  const m = varMeta();
  rows.push(`${m.label}${hasLevels() ? ` ${S.level} hPa` : ''}: ${raw == null ? 'n/a' : `${fmt(show(raw))} ${conv().unit}`}`);
  if (S.variable !== 'mean_sea_level_pressure') {
    const p = sampleRaw(S.isoPack, S.isoPack?.entry, lngLat);
    if (p != null) rows.push(`MSLP: ${(p / 100).toFixed(1)} hPa`);
  }
  const w = sampleWind(lngLat);
  if (w) rows.push(`Wind: ${w.speed.toFixed(1)} m/s from ${Math.round(w.dir)}° ${COMPASS[Math.round(w.dir / 22.5) % 16]}`);
  el.textContent = rows.join('\n');
}

function onHover(e) {
  S.cursor = e.lngLat;
  updateReadout(S.cursor);
}

// ---------- isobars ----------
function ensureIsoPack() {
  const entry = S.manifest.fields.mean?.mean_sea_level_pressure;
  if (!entry) return null;
  if (!S.isoPack || S.isoPack.entry !== entry) {
    S.isoPack?.destroy();
    S.isoPack = new FramePack(S.manifest.base, entry, { concurrency: 2 });
    S.isoPack.prefetchFrom(Math.round(S.t));
    S.isoFrame = -1;
  }
  return S.isoPack;
}

/** Contours are computed per forecast frame (nearest to the current time) in a worker. */
function requestContours() {
  if (!S.iso) return;
  const pack = ensureIsoPack();
  if (!pack) return;
  const i = Math.min(Math.round(S.t), T() - 1);
  if (i === S.isoFrame || (S.isoBusy && i === S.isoRequested)) return;
  const px = pack.pixels(i, 2);
  if (!px) { pack.frame(i).then(() => { S.dirty = true; }).catch(() => {}); return; }
  if (S.isoBusy) return;                       // the loop asks again after the running job finishes
  S.isoBusy = true;
  S.isoRequested = i;
  if (!worker) {
    worker = new Worker(new URL('./contour-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      overlay.setContours(data);
      S.isoFrame = data.id;
      S.isoBusy = false;
      S.dirty = true;
    };
    worker.onerror = (e) => {
      console.error('contour worker', e);
      toast(`Isobar computation failed: ${e.message || 'worker error'}`);
      S.isoBusy = false; S.iso = false; $('chk-iso').checked = false; overlay.showIsobars = false;
    };
  }
  worker.postMessage({ id: i, codes: px, W: S.manifest.grid.width, H: S.manifest.grid.height,
    range: pack.entry.range, grid: S.manifest.grid });
}

// ---------- point forecast ----------
async function onClick(e) {
  if (Math.abs(e.lngLat.lat) > MAX_LAT) return;
  S.marker?.remove();
  S.marker = new maplibregl.Marker({ color: '#5aa6ff' }).setLngLat(e.lngLat).addTo(map);
  $('point-title').textContent = `${Math.abs(e.lngLat.lat).toFixed(2)}°${e.lngLat.lat >= 0 ? 'N' : 'S'}, ${Math.abs(e.lngLat.lng).toFixed(2)}°${e.lngLat.lng >= 0 ? 'E' : 'W'}`;
  $('point-note').textContent = 'Loading…';
  $('point-panel').hidden = false;
  const entries = Object.entries(S.manifest.points);
  try {
    // Each point file has its own (possibly coarser) grid over the same extent.
    const recs = await Promise.all(entries.map(([, en]) => {
      const { x, y } = gridIndex({ ...S.manifest.grid, width: en.width, height: en.height }, e.lngLat.lng, e.lngLat.lat);
      return fetchPoint(S.manifest.base, en, x, y);
    }));
    S.points = Object.fromEntries(entries.map(([id, en], i) => [id, { entry: en, rec: recs[i] }]));
    $('point-note').textContent = S.manifest.members === 1 ? 'Ground truth (ERA5), single value per hour'
      : `${S.manifest.members} ensemble members · thick line = mean${S.manifest.members >= 5 ? ' · band = 10–90 %' : ''}`;
    renderTabs();
  } catch (err) {
    $('point-note').textContent = `Could not load point forecast: ${err.message}`;
  }
}

function pointLabel(id) {
  const en = S.points[id].entry, m = S.manifest.variables[en.variable];
  return en.level == null ? m.label : `${m.label} ${en.level} hPa`;
}

function renderTabs(active) {
  const ids = Object.keys(S.points);
  active = active || (ids.includes(curId()) ? curId() : ids[0]);
  const tabs = $('point-tabs');
  tabs.replaceChildren(...ids.map((id) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: pointLabel(id) });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(id === active));
    b.onclick = () => renderTabs(id);
    return b;
  }));
  const { entry, rec } = S.points[active];
  plume($('plume'), rec, entry.members, entry.times, S.manifest.lead_hours, S.manifest.variables[entry.variable]);
}

// ---------- verification ----------
async function showSkill() {
  const panel = $('skill-panel'), box = $('skill-charts');
  panel.hidden = false;
  box.replaceChildren();
  $('skill-note').textContent = 'Loading…';
  let v = null;
  try { v = await getJSON(`runs/${S.manifest.run_id}/verification.json`, { optional: true }); } catch { /* shown below */ }
  if (!v) {
    $('skill-note').textContent = 'Not available yet. Verification is computed once the analysis for this run’s valid times exists (about 5 days for ERA5). Pick an older run above.';
    return;
  }
  $('skill-note').textContent = 'Latitude-weighted, against the analysis. Lower is better; a well-calibrated ensemble has spread ≈ RMSE.';
  for (const [id, f] of Object.entries(v.fields)) {
    const en = S.manifest.points[id], m = S.manifest.variables[en.variable];
    const div = document.createElement('div');
    div.className = 'skill';
    const sc = m.unit_scale; // errors are differences: scale applies, offset does not
    const series = [
      { y: f.rmse.map((x) => x * sc), color: '#ff8a5b', width: 2 },
      { y: f.spread.map((x) => x * sc), color: '#5aa6ff', width: 2 },
      { y: f.crps.map((x) => x * sc), color: '#9be08a', width: 2 },
    ];
    div.innerHTML = `<h3></h3><canvas></canvas><div class="key"><span><i style="background:#ff8a5b"></i>RMSE</span><span><i style="background:#5aa6ff"></i>spread</span><span><i style="background:#9be08a"></i>CRPS</span></div>`;
    div.querySelector('h3').textContent = `${m.label}${en.level == null ? '' : ` ${en.level} hPa`} (${m.unit})`;
    box.append(div);
    lineChart(div.querySelector('canvas'), { x: v.lead_hours, series, zeroBased: true });
  }
}

// ---------- UI wiring ----------
function fillVariableSelect() {
  const sel = $('sel-var'), vars = Object.entries(S.manifest.variables);
  const group = (label, items) => {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const [k, m] of items) g.append(new Option(m.label, k));
    return g;
  };
  sel.replaceChildren(group('Surface', vars.filter(([, m]) => !m.levels)), group('Pressure levels', vars.filter(([, m]) => m.levels)));
  if (!S.manifest.variables[S.variable]) S.variable = vars[0][0];
  sel.value = S.variable;
  $('sel-level').replaceChildren(...S.manifest.levels.map((l) => new Option(`${l} hPa`, l)));
  if (!S.manifest.levels.includes(S.level)) S.level = S.manifest.levels.includes(500) ? 500 : S.manifest.levels[0];
  $('sel-level').value = S.level;
}

function fillProductSelect() {
  const id = curId();
  const avail = Object.keys(S.manifest.products).filter((p) => S.manifest.fields[p]?.[id]);
  $('sel-prod').replaceChildren(...avail.map((p) => new Option(S.manifest.products[p].label, p)));
  if (!avail.includes(S.product)) S.product = avail[0];
  $('sel-prod').value = S.product;
}

function fillColormapSelect() {
  const def = defaultCmap();
  $('sel-cmap').replaceChildren(...COLORMAP_NAMES.map((n) => new Option(n === def ? `${n} (default)` : n, n)));
  $('sel-cmap').value = S.cmap || def;
}

function applySelection() {
  $('row-level').hidden = !hasLevels();
  S.cmap = null;                       // colormaps are chosen per field: back to its default
  fillProductSelect();
  fillColormapSelect();
  loadField();
  loadWind();
  saveHash();
  if (S.points) renderTabs();
}

function saveHash() {
  const p = new URLSearchParams({ v: S.variable, p: S.product, w: S.wind ? 1 : 0, r: S.manifest.run_id });
  if (hasLevels()) p.set('l', S.level);
  history.replaceState(null, '', `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('v')) S.variable = p.get('v');
  if (p.get('p')) S.product = p.get('p');
  if (p.get('l')) S.level = Number(p.get('l'));
  if (p.has('w')) S.wind = p.get('w') === '1';
  return p.get('r');
}

async function useRun(runId) {
  S.manifest = await loadRun(runId);
  const when = `${S.manifest.init_time.slice(0, 13).replace('T', ' ')}Z`;
  $('run-info').textContent = S.manifest.kind === 'analysis' ? `ERA5 ground truth · ${when}` : `init ${when} · ${S.manifest.members} members`;
  $('slider').max = String((T() - 1) * 100);
  S.t = Math.min(S.t, T() - 1);
  S.points = null;
  S.isoFrame = -1;
  overlay.setContours(null);
  $('point-panel').hidden = true;
  fillVariableSelect();
  applySelection();
}

async function fillRunSelect(currentId) {
  const idx = await getJSON('runs.json', { optional: true });
  S.runs = idx?.runs?.length ? idx.runs : [currentId];
  $('sel-run').replaceChildren(...S.runs.map((r, i) => new Option(i === 0 ? `${r} (latest)` : r, r)));
  $('sel-run').value = currentId;
}

function pollForNewRun() {
  setInterval(async () => {
    try {
      const latest = await getJSON('latest.json');
      if (latest.run_id !== S.runs[0] && S.manifest.run_id === S.runs[0]) {
        toast('A new forecast run is available.', { label: 'Load', fn: () => location.reload() });
      }
    } catch { /* offline: try again next time */ }
  }, 5 * 60 * 1000);
}

function wireUI() {
  $('sel-var').onchange = (e) => { S.variable = e.target.value; applySelection(); };
  $('sel-level').onchange = (e) => { S.level = Number(e.target.value); applySelection(); };
  $('sel-prod').onchange = (e) => { S.product = e.target.value; applySelection(); };
  $('sel-run').onchange = async (e) => { await useRun(e.target.value); };
  $('chk-wind').onchange = (e) => { S.wind = e.target.checked; S.dirty = true; saveHash(); };
  $('rng-wind').oninput = (e) => { particles.speed = Number(e.target.value); };
  $('chk-iso').onchange = (e) => { S.iso = overlay.showIsobars = e.target.checked; overlay.draw(); S.dirty = true; };
  $('chk-grid').onchange = (e) => { overlay.showGraticule = e.target.checked; overlay.draw(); };
  $('rng-opacity').oninput = (e) => { fieldGL.opacity = Number(e.target.value) / 100; S.dirty = true; };
  $('sel-cmap').onchange = (e) => { S.cmap = e.target.value; fieldGL.setColormap(S.cmap); updateLegend(); S.dirty = true; };
  const applyRange = () => {
    const lo = parseFloat($('in-min').value), hi = parseFloat($('in-max').value), c = conv();
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo < hi)) { updateLegend(); return; }
    let rawLo = (lo - c.offset) / c.scale, rawHi = (hi - c.offset) / c.scale;
    if (curEntry().transform === 'sqrt') rawLo = Math.max(0, rawLo);
    S.ranges[rangeKey()] = [rawLo, rawHi];
    updateLegend(); S.dirty = true;
  };
  $('in-min').onchange = applyRange;
  $('in-max').onchange = applyRange;
  $('btn-reset-range').onclick = () => { delete S.ranges[rangeKey()]; updateLegend(); S.dirty = true; };
  $('btn-skill').onclick = showSkill;
  $('btn-play').onclick = togglePlay;
  $('slider').oninput = (e) => { S.t = Number(e.target.value) / 100; S.playing = false; syncPlayButton(); S.dirty = true; };
  document.querySelectorAll('.close').forEach((b) => (b.onclick = () => {
    $(b.dataset.close).hidden = true;
    if (b.dataset.close === 'point-panel') { S.marker?.remove(); S.marker = null; }
  }));
  addEventListener('keydown', (e) => {
    if (e.target.matches('select, input[type=range]') && e.key !== ' ') return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowRight') { S.t = Math.min(T() - 1, Math.floor(S.t) + 1); S.dirty = true; }
    if (e.key === 'ArrowLeft') { S.t = Math.max(0, Math.ceil(S.t) - 1); S.dirty = true; }
  });
  map.on('mousemove', onHover);
  map.on('mouseout', () => { S.cursor = null; updateReadout(null); });
  map.on('click', onClick);
  addEventListener('resize', () => S.points && renderTabs());
}

function togglePlay() { S.playing = !S.playing; syncPlayButton(); }
function syncPlayButton() { $('btn-play').textContent = S.playing ? '❚❚' : '▶'; $('btn-play').setAttribute('aria-label', S.playing ? 'Pause' : 'Play'); }

async function main() {
  const wantedRun = readHash();
  await initMap();
  initFieldLayer();
  particles = new WindParticles(map, $('wind'), { count: matchMedia('(pointer: coarse)').matches ? 2500 : 6000 });
  overlay = new Overlay(map, $('overlay'));
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-right');
  wireUI();
  $('chk-wind').checked = S.wind;
  try {
    const latest = await getJSON('latest.json');
    await fillRunSelect(latest.run_id);
    const id = S.runs.includes(wantedRun) ? wantedRun : latest.run_id;
    $('sel-run').value = id;
    await useRun(id);
  } catch (err) {
    toast(`No forecast published yet (${err.message}).`);
    return;
  }
  pollForNewRun();
  requestAnimationFrame(loop);
}

main();
