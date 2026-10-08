// Reads a point file written by Python and prints decoded records (JSON), so
// pytest can compare Python and JS decoders. Also checks grid helpers + colormaps.
import { readFileSync } from 'node:fs';
import { decodePoint, gridIndex, gridLonLat, pointRange } from '../../web/js/geo.js';
import { turbo, lut } from '../../web/js/colormaps.js';

const [, , file, entryJson, coords] = process.argv;
const entry = JSON.parse(entryJson);
const buf = readFileSync(file);
const out = { records: [], grid: {}, turbo: [turbo(0), turbo(0.5), turbo(1)], lutLen: lut('rain').length };
for (const [x, y] of JSON.parse(coords)) {
  const { start, end } = pointRange(entry, x, y);
  const ab = buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + end + 1);
  out.records.push(Array.from(decodePoint(entry, ab)));
}
const grid = { width: 1440, height: 721, lat: [90, -90], lon: [-180, 179.75] };
out.grid.idx = [gridIndex(grid, -180, 90), gridIndex(grid, 0, 0), gridIndex(grid, 179.9, -90), gridIndex(grid, -190, 95)];
out.grid.ll = gridLonLat(grid, 720, 360);
console.log(JSON.stringify(out));
