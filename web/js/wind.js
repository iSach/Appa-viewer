// Animated wind particles on a 2D overlay canvas. u/v come from the wind packs
// (R = u, G = v, both mapped from [-vmax, vmax] to 0..255), time-interpolated.

export class WindParticles {
  constructor(map, canvas, { count = 5000 } = {}) {
    this.map = map;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.n = count;
    this.lon = new Float32Array(count);
    this.lat = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.enabled = false;
    this.speed = 1;          // user multiplier on particle speed
    this.wind = null; // {grid, vmax, a: Uint8Array|null, b: Uint8Array|null, mix}
    for (let i = 0; i < count; i++) this._spawn(i, true);
    map.on('movestart', () => this.clear());
    map.on('move', () => this.clear());
    map.on('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), r = this.map.getContainer().getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.dpr = dpr;
  }

  clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }

  setEnabled(on) { this.enabled = on; if (!on) this.clear(); }

  /** a/b: pixel arrays of the two bracketing frames (null while loading). */
  setWind(grid, vmax, a, b, mix) { this.wind = { grid, vmax, a, b, mix }; }

  _spawn(i, anyAge = false) {
    const b = this.map.getBounds();
    const w = b.getEast() - b.getWest();
    this.lon[i] = w >= 360 ? Math.random() * 360 - 180 : b.getWest() + Math.random() * w;
    const n = b.getNorth(), s = b.getSouth();
    this.lat[i] = Math.max(-85, Math.min(85, s + Math.random() * (n - s)));
    this.life[i] = 1.8 + Math.random() * 2.2;            // seconds; varied so particles don't die in sync
    this.age[i] = anyAge ? Math.random() * this.life[i] : 0;
  }

  _uv(lon, lat) {
    const { grid, vmax, a, b, mix } = this.wind;
    const W = grid.width, H = grid.height;
    const x = ((Math.round(((lon + 180) / 360) * W) % W) + W) % W;
    const y = Math.min(H - 1, Math.max(0, Math.round(((grid.lat[0] - lat) / (grid.lat[0] - grid.lat[1])) * (H - 1))));
    const o = (y * W + x) * 2;
    let u = a[o], v = a[o + 1];
    if (b) { u += (b[o] - u) * mix; v += (b[o + 1] - v) * mix; }
    return [(u / 255 - 0.5) * 2 * vmax, (v / 255 - 0.5) * 2 * vmax];
  }

  /** dt in seconds. Speeds are in px/s so motion is the same on 60 and 144 Hz screens. */
  tick(dt = 1 / 60) {
    if (!this.enabled || !this.wind || !this.wind.a) return;
    const { ctx, map, dpr } = this;
    ctx.globalCompositeOperation = 'destination-in';       // fade old trails
    ctx.fillStyle = `rgba(0,0,0,${(0.955 ** (dt * 60)).toFixed(3)})`;   // slower fade = longer trails
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.7 * dpr;
    ctx.lineCap = 'round';
    const degPerPx = 360 / (512 * 2 ** map.getZoom());
    const k = 5 * this.speed * dt;                          // px per (m/s) per second: 20 m/s -> ~100 px/s
    const cw = this.canvas.width / dpr, ch = this.canvas.height / dpr, margin = 24;
    const maxStep = 80;                                      // px: anything longer is a bug, never draw it
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] > this.life[i]) { this._spawn(i); continue; }
      const [u, v] = this._uv(this.lon[i], this.lat[i]);
      const p0 = map.project([this.lon[i], this.lat[i]]);
      const cos = Math.cos((this.lat[i] * Math.PI) / 180);
      this.lon[i] += u * k * degPerPx;
      this.lat[i] += v * k * degPerPx * cos;
      // Longitude is deliberately NOT wrapped: wrapping jumps the particle by a whole world on screen and
      // draws a streak across the map. Sampling (_uv) wraps for itself, and the map draws world copies.
      if (Math.abs(this.lat[i]) > 85) { this._spawn(i); continue; }
      const p1 = map.project([this.lon[i], this.lat[i]]);
      if (p1.x < -margin || p1.x > cw + margin || p1.y < -margin || p1.y > ch + margin ||
          Math.abs(p1.x - p0.x) > maxStep || Math.abs(p1.y - p0.y) > maxStep) { this._spawn(i); continue; }
      const speed = Math.hypot(u, v);
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.95, 0.5 + speed / 25).toFixed(2)})`;
      ctx.beginPath();
      ctx.moveTo(p0.x * dpr, p0.y * dpr);
      ctx.lineTo(p1.x * dpr, p1.y * dpr);
      ctx.stroke();
    }
  }
}
