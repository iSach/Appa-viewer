// 2D overlay drawn above the map: graticule, isobars with labels, pressure centres (H / L).
// Geometry arrives in Web Mercator world coordinates ([0,1], y down), so panning and zooming
// is just a cheap re-projection. No MapLibre text layers (they need a glyph server).
import { mercator } from './contours.js';

const GRATICULE_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 45, 90];

export class Overlay {
  constructor(map, canvas) {
    this.map = map;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.contours = null;
    this.showIsobars = true;
    this.showGraticule = true;
    this.isoOpacity = 1;      // applies to isobars, their labels and the H/L markers (not the graticule)
    map.on('move', () => this.draw());
    map.on('resize', () => { this.resize(); this.draw(); });
    this.resize();
  }

  resize() {
    const r = this.map.getContainer().getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr; this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
  }

  setContours(data) { this.contours = data; this.draw(); }

  _view() {
    const c = this.map.getCenter(), m = mercator(c.lng, c.lat), world = 512 * 2 ** this.map.getZoom();
    return { cx: m[0], cy: m[1], world, x0: m[0] - this.w / 2 / world, x1: m[0] + this.w / 2 / world,
             y0: m[1] - this.h / 2 / world, y1: m[1] + this.h / 2 / world };
  }

  draw() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const v = this._view();
    if (this.showGraticule) this._graticule(v);
    if (this.showIsobars && this.contours) this._isobars(v);
  }

  _graticule(v) {
    const { ctx, w, h } = this;
    const step = GRATICULE_STEPS.find((s) => (s / 360) * v.world >= 90) || 90;
    const sx = (wx) => (wx - v.cx) * v.world + w / 2, sy = (wy) => (wy - v.cy) * v.world + h / 2;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(200,215,235,0.6)';
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    const lon0 = Math.floor((v.x0 * 360 - 180) / step) * step, lon1 = v.x1 * 360 - 180;
    ctx.beginPath();
    for (let lon = lon0; lon <= lon1; lon += step) {
      const x = Math.round(sx((lon + 180) / 360)) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    const latOf = (wy) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;
    const latTop = Math.min(85, latOf(v.y0)), latBot = Math.max(-85, latOf(v.y1));
    for (let lat = Math.ceil(latBot / step) * step; lat <= latTop; lat += step) {
      const y = Math.round(sy(mercator(0, lat)[1])) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    for (let lon = lon0; lon <= lon1; lon += step) {
      const l = ((((lon + 180) % 360) + 360) % 360) - 180, x = sx((lon + 180) / 360);
      if (x > 4 && x < w - 40) ctx.fillText(`${fmtDeg(Math.abs(l), step)}${l < 0 ? '°W' : l > 0 ? '°E' : '°'}`, x + 3, 4);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    for (let lat = Math.ceil(latBot / step) * step; lat <= latTop; lat += step) {
      const y = sy(mercator(0, lat)[1]);
      if (y > 20 && y < h - 6) ctx.fillText(`${fmtDeg(Math.abs(lat), step)}${lat < 0 ? '°S' : lat > 0 ? '°N' : '°'}`, w - 6, y - 2);
    }
  }

  _isobars(v) {
    const { ctx, w, h } = this, { lines, labels, centres } = this.contours;
    const kMin = Math.floor(v.x0), kMax = Math.floor(v.x1);          // world copies in view
    ctx.save();
    ctx.globalAlpha = this.isoOpacity;
    const px = (x, k) => (x + k - v.cx) * v.world + w / 2, py = (y) => (y - v.cy) * v.world + h / 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const pass of [{ major: false, dark: true }, { major: true, dark: true }, { major: false }, { major: true }]) {
      ctx.beginPath();
      for (const L of lines) {
        if (L.major !== pass.major) continue;
        const [bx0, by0, bx1, by1] = L.bbox;
        if (by1 < v.y0 || by0 > v.y1) continue;
        for (let k = kMin; k <= kMax; k++) {
          if (bx1 + k < v.x0 || bx0 + k > v.x1) continue;
          const p = L.pts;
          ctx.moveTo(px(p[0], k), py(p[1]));
          for (let i = 2; i < p.length; i += 2) ctx.lineTo(px(p[i], k), py(p[i + 1]));
        }
      }
      ctx.strokeStyle = pass.dark ? 'rgba(5,10,20,0.45)' : pass.major ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.62)';
      ctx.lineWidth = pass.dark ? (pass.major ? 3.4 : 2.4) : pass.major ? 1.5 : 0.9;
      ctx.stroke();
    }

    // Value labels on the lines, skipping any that would crowd an already placed one.
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const placed = [];
    for (const lab of labels) {
      for (let k = kMin; k <= kMax; k++) {
        const x = px(lab.x, k), y = py(lab.y);
        if (x < 10 || x > w - 10 || y < 10 || y > h - 10) continue;
        if (placed.some(([qx, qy]) => Math.abs(qx - x) < 54 && Math.abs(qy - y) < 22)) continue;
        placed.push([x, y]);
        ctx.save(); ctx.translate(x, y); ctx.rotate(lab.a);
        ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(8,12,22,0.9)'; ctx.strokeText(lab.text, 0, 0);
        ctx.fillStyle = '#fff'; ctx.fillText(lab.text, 0, 0);
        ctx.restore();
      }
    }

    // Highs and lows.
    ctx.textBaseline = 'alphabetic';
    for (const c of centres) {
      for (let k = kMin; k <= kMax; k++) {
        const x = px(c.pos[0], k), y = py(c.pos[1]);
        if (x < 14 || x > w - 14 || y < 20 || y > h - 20) continue;
        const col = c.type === 'H' ? '#8cc4ff' : '#ff8f7a';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,12,22,0.9)'; ctx.fillStyle = col;
        ctx.font = '700 22px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.strokeText(c.type, x, y + 4); ctx.fillText(c.type, x, y + 4);
        ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.strokeText(String(c.value), x, y + 18); ctx.fillText(String(c.value), x, y + 18);
      }
    }
    ctx.restore();
  }
}

function fmtDeg(d, step) { return step < 1 ? d.toFixed(2).replace(/0$/, '') : String(d); }
