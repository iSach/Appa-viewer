// WebGL renderer drawn on its own full-screen canvas *underneath* the map: for every
// screen pixel the shader inverts the map's Web Mercator view (centre + zoom) to
// lon/lat, bilinear-samples the equirectangular source grid, blends two frames in
// time and applies the colormap. No intermediate image, so it is crisp at any zoom.
import { lut } from './colormaps.js';

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uA, uB, uLut;
uniform float uMix, uOpacity, uTransparentBelow, uWorld;
uniform vec2 uView;     // canvas size in device px
uniform vec2 uCenter;   // map centre in Mercator world coordinates ([0,1], y down)
uniform ivec2 uTex;
uniform vec3 uGrid;     // lon0, lat0 (north), lat1 (south)
uniform vec2 uRange;    // quantisation range (transformed space)
uniform vec2 uDisp;     // colour scale (raw units)
uniform int uWide, uSqrt;
out vec4 o;
const float PI = 3.14159265358979;

// Returns 0..1, or -1 for "missing" (code 0 is reserved for NaN, e.g. SST over land).
float at(sampler2D t, int x, int y) {
  x = ((x % uTex.x) + uTex.x) % uTex.x;
  y = clamp(y, 0, uTex.y - 1);
  vec4 c = texelFetch(t, ivec2(x, y), 0);
  float code = floor(c.r * 255.0 + 0.5);
  float top = 255.0;
  if (uWide == 1) { code = code * 256.0 + floor(c.g * 255.0 + 0.5); top = 65535.0; }
  if (code < 0.5) return -1.0;
  return (code - 1.0) / (top - 1.0);
}
// Manual bilinear: hardware filtering would blend the high and low bytes of 16-bit values separately.
// Missing neighbours are left out of the average; mostly-missing pixels stay missing (crisp coastlines).
float bilinear(sampler2D t, float lon, float lat) {
  float dlon = 360.0 / float(uTex.x);
  float dlat = (uGrid.y - uGrid.z) / float(uTex.y - 1);
  float x = (lon - uGrid.x) / dlon;
  float y = clamp((uGrid.y - lat) / dlat, 0.0, float(uTex.y - 1));
  int x0 = int(floor(x)), y0 = int(floor(y));
  float fx = x - floor(x), fy = y - floor(y);
  int y1 = min(y0 + 1, uTex.y - 1);
  float v[4] = float[4](at(t, x0, y0), at(t, x0 + 1, y0), at(t, x0, y1), at(t, x0 + 1, y1));
  float w[4] = float[4]((1.0 - fx) * (1.0 - fy), fx * (1.0 - fy), (1.0 - fx) * fy, fx * fy);
  float acc = 0.0, ws = 0.0;
  for (int i = 0; i < 4; i++) if (v[i] >= 0.0) { acc += v[i] * w[i]; ws += w[i]; }
  return ws < 0.5 ? -1.0 : acc / ws;
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y) - 0.5 * uView;   // px from centre, y down
  vec2 w = uCenter + p / uWorld;                    // Mercator world coordinates of this pixel
  if (w.y < 0.0 || w.y > 1.0) { o = vec4(0.0); return; }
  float lon = (w.x - floor(w.x)) * 360.0 - 180.0;   // wraps around the antimeridian
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * w.y))));
  float qa = bilinear(uA, lon, lat), qb = bilinear(uB, lon, lat);
  if (qa < 0.0 || qb < 0.0) { o = vec4(0.0); return; }
  float q = mix(qa, qb, uMix);
  float raw = uRange.x + q * (uRange.y - uRange.x);
  if (uSqrt == 1) raw = raw * raw;
  float t;
  if (uSqrt == 1) {
    float s0 = sqrt(max(uDisp.x, 0.0));
    t = (sqrt(max(raw, 0.0)) - s0) / (sqrt(uDisp.y) - s0);
  } else {
    t = (raw - uDisp.x) / (uDisp.y - uDisp.x);
  }
  vec4 c = texture(uLut, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  float a = c.a * uOpacity;
  if (raw < uTransparentBelow) a *= smoothstep(uTransparentBelow * 0.5, uTransparentBelow, raw);
  o = vec4(c.rgb * a, a);                            // premultiplied, as MapLibre expects
}`;

export class FieldGL {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 is required');
    this.prog = this._program(VS, FS);
    this.u = Object.fromEntries(['uA', 'uB', 'uLut', 'uMix', 'uOpacity', 'uTransparentBelow', 'uWorld', 'uView', 'uCenter',
      'uTex', 'uGrid', 'uRange', 'uDisp', 'uWide', 'uSqrt'].map((n) => [n, gl.getUniformLocation(this.prog, n)]));
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one big triangle
    const loc = gl.getAttribLocation(this.prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.lutTex = gl.createTexture();
    this.opacity = 1;
    this.dpr = 1;
  }

  resize(cssWidth, cssHeight, dpr) {
    this.dpr = dpr;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
  }

  _program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  makeTexture(bitmap) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  deleteTexture(t) { this.gl.deleteTexture(t); }

  setColormap(name) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut(name));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * field: {entry, grid, transparentBelow}; texA/texB: frame textures; mix in [0,1];
   * view: {center: [x, y] in Mercator world coords, world: world size in CSS px (512 * 2^zoom)}.
   */
  draw(field, texA, texB, mix, disp, view) {
    const gl = this.gl, u = this.u, { entry, grid } = field;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!texA) return;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB || texA);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(u.uA, 0); gl.uniform1i(u.uB, 1); gl.uniform1i(u.uLut, 2);
    gl.uniform1f(u.uMix, texB ? mix : 0);
    gl.uniform2f(u.uView, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uCenter, view.center[0], view.center[1]);
    gl.uniform1f(u.uWorld, view.world * this.dpr);
    gl.uniform1f(u.uOpacity, this.opacity);
    gl.uniform1f(u.uTransparentBelow, field.transparentBelow ?? -1e30);
    gl.uniform2i(u.uTex, grid.width, grid.height);
    gl.uniform3f(u.uGrid, grid.lon[0], grid.lat[0], grid.lat[1]);
    gl.uniform2f(u.uRange, entry.range[0], entry.range[1]);
    gl.uniform2f(u.uDisp, disp[0], disp[1]);
    gl.uniform1i(u.uWide, entry.bits === 16 ? 1 : 0);
    gl.uniform1i(u.uSqrt, entry.transform === 'sqrt' ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
