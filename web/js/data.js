// Manifest + frame loading. Everything is static files; frames and per-point
// records come out of packs with HTTP Range requests.
import { decodePoint, pointRange } from './geo.js';

export const DATA_ROOT = new URL('../data/', import.meta.url).href;

export async function getJSON(path, { optional = false } = {}) {
  const res = await fetch(new URL(path, DATA_ROOT), { cache: 'no-store' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  return res.json();
}

export async function loadRun(runId) {
  const latest = runId ? null : await getJSON('latest.json');
  const id = runId || latest.run_id;
  const manifest = await getJSON(`runs/${id}/manifest.json`);
  manifest.base = new URL(`runs/${id}/`, DATA_ROOT).href;
  return manifest;
}

async function rangeFetch(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status === 206) return res.arrayBuffer();
  if (res.status === 200) {
    // Server ignored Range. Fine for small packs, hopeless for big point files.
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 64e6) { res.body?.cancel(); throw new Error('server does not support HTTP Range requests'); }
    return (await res.arrayBuffer()).slice(start, end + 1);
  }
  throw new Error(`HTTP ${res.status} for ${url}`);
}

/** All frames of one field: lazy, de-duplicated, fetched `concurrency` at a time. */
export class FramePack {
  constructor(base, entry, { concurrency = 4, onFrame = () => {}, onError = () => {} } = {}) {
    this.url = new URL(entry.file, base).href;
    this.entry = entry;
    this.onFrame = onFrame;
    this.onError = onError;
    this.bitmaps = new Map();
    this.pending = new Map();
    this.queue = [];
    this.active = 0;
    this.concurrency = concurrency;
    this.pixelCache = new Map();
    this.dead = false;
  }
  get count() { return this.entry.frames.length; }

  frame(i) {
    if (this.pending.has(i)) {
      // Already requested: if it is still waiting in the queue, a new demand moves it to the front.
      const k = this.queue.findIndex((j) => j.i === i);
      if (k > 0) this.queue.unshift(this.queue.splice(k, 1)[0]);
      return this.pending.get(i);
    }
    const p = new Promise((resolve, reject) => this.queue.push({ i, resolve, reject }));
    this.pending.set(i, p);
    this._pump();
    return p;
  }

  prefetchFrom(center) {
    const order = [...Array(this.count).keys()].sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    order.forEach((i) => this.frame(i).catch(() => {})); // failures are reported through onError
  }

  _pump() {
    while (this.active < this.concurrency && this.queue.length && !this.dead) {
      const job = this.queue.shift();
      this.active++;
      this._load(job.i).then(job.resolve, job.reject).finally(() => { this.active--; this._pump(); });
    }
  }

  async _load(i) {
    try { return await this._fetchFrame(i); } catch (err) { if (!this.dead) this.onError(i, err); throw err; }
  }

  async _fetchFrame(i) {
    const [off, len] = this.entry.frames[i];
    const buf = await rangeFetch(this.url, off, off + len - 1);
    // Raw bytes matter (16-bit values are split over R and G): no colour conversion, no premultiply.
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }),
      { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (this.dead) { bmp.close(); return bmp; }
    this.bitmaps.set(i, bmp);
    this.onFrame(i, bmp);
    return bmp;
  }

  /** CPU copy of one frame as Uint8Array [H*W*channels] (R, or R+G for 16-bit / wind). */
  pixels(i, channels) {
    const key = `${i}:${channels}`;
    if (this.pixelCache.has(key)) return this.pixelCache.get(key);
    const bmp = this.bitmaps.get(i);
    if (!bmp) return null;
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    ctx.drawImage(bmp, 0, 0);
    const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const out = new Uint8Array(bmp.width * bmp.height * channels);
    for (let p = 0, o = 0; p < rgba.length; p += 4) {
      out[o++] = rgba[p];
      if (channels > 1) out[o++] = rgba[p + 1];
    }
    this.pixelCache.set(key, out);
    return out;
  }

  destroy() {
    this.dead = true;
    this.queue.length = 0;
    for (const b of this.bitmaps.values()) b.close();
    this.bitmaps.clear();
    this.pixelCache.clear();
  }
}

export async function fetchPoint(base, entry, x, y) {
  const { start, end } = pointRange(entry, x, y);
  const buf = await rangeFetch(new URL(entry.file, base).href, start, end);
  return decodePoint(entry, buf);
}
