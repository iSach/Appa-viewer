# APPA Live 2

Global ensemble weather forecasts from APPA, published as **static files** and explored in a WebGL viewer.
The GPU machine writes files; the web server only serves them. No dynamic website, no S3, no tile server.

```
GPU (cron)                                         web server (nginx, static)
fetch -> encode -> N-member ensemble               web/            viewer (plain ES modules + MapLibre)
  -> stats on GPU -> quantised PNG packs   ----->  web/data/       latest.json, runs.json
  -> per-point ensemble files                                      runs/<id>/manifest.json
  -> atomic publish (latest.json last)                             runs/<id>/fields/<stat>/<field>.pack
                                                                   runs/<id>/points/<field>.u16
```

## What changed vs. appa-live

| appa-live | here |
|---|---|
| mean/median/std zarr, then `gdal2tiles` PNG tiles at zoom 0-3, PMTiles, `aws s3 sync` | the global 0.25° grid is **one image per field and time**; the browser does colormap, interpolation and animation in a shader. The data canvas sits under a transparent MapLibre map (borders only) and the shader inverts the map's Web Mercator view per screen pixel, so it is crisp at any zoom. Flat map only (no globe). No gdal, no tiler, no upload. |
| isobar GeoJSON and wind JSON files | wind is a 2-channel PNG pack animated as particles; isobars not ported yet |
| mean, median, std | mean, std, p10, p90, exceedance probabilities (heat, freeze, rain, gale) |
| 6 surface + 5 level variables | + 10 m wind speed, wind speed and relative humidity on every level |
| click does nothing | click -> all ensemble members at that point (one HTTP Range request per field) |
| none | skill panel (RMSE / spread / CRPS vs lead time) from the stored member data |

## Data format

* **Field pack** `fields/<stat>/<field>.pack`: concatenated lossless PNG frames, one per lead time. 8-bit fields use
  the R channel; 16-bit fields (temperature, pressure, geopotential) use R = high byte, G = low byte. `manifest.json`
  lists `[offset, length]` per frame, so the viewer fetches any frame with a Range request. `range` is the true min/max
  of the data (nothing is clipped; hover values stay exact to one quantisation step), `display_range` is the robust
  colour scale. Fields with `transform: "sqrt"` (rain, humidity) are quantised in sqrt space; `range` is in that space.
* **Point file** `points/<field>.u16`: uint16 `[H, W, members, times]`, so one grid cell is one contiguous record.
  Size = `H*W*members*times*2 / stride²` bytes per field, which is the main storage cost (see below).
* **Wind pack** `fields/wind/wind_<10m|level>.pack`: R = u, G = v, mapped from `[-vmax, vmax]` to 0..255.
* `latest.json` is replaced atomically **after** the run directory is complete, so visitors never see half a run.

## Use

```bash
# tests (python + node; no GPU needed)
micromamba run -n appa python -m pytest -q tests

# fake demo data, then view it
micromamba run -n appa python -m appa_live2.build --synthetic --grid 361x720 --out web/data
python serve.py 8000          # then open http://127.0.0.1:8000  (nginx does the same in production: deploy/nginx.conf)

# deploying to a web server with Caddy: see DEPLOY.md (runbook) and deploy/Caddyfile

# real run on the GPU machine (cron every 6 h)
python -m appa_live2.pipeline --appa-live ~/appa-live -c forecast/config/example.yaml -n 8 --out /var/www/appa/web/data
```

Run verification when analysis exists for a past run (`verify.verify_run(run_dir, analysis_fn)`); the skill panel in the
viewer then shows it. `analysis_fn(var, level, valid_times) -> [T, H, W]` is yours to provide (e.g. ERA5 via CDS).

## Storage

Per run, for a 0.25° grid and 8 members x 13 lead times, `point_stride=1`: about 6 point files x 190 MB = 1.1 GB plus
~0.5-1 GB of field packs. `--point-stride 2` (0.5° click resolution) divides the point files by 4. `--keep` bounds the
number of runs on disk (default 4). The file count stays around 120 per run.

## Status

Tested (14 tests): quantise/PNG round-trips, manifest and frame offsets, derived-variable maths, probabilities,
point files (Python reader and an independent JS reader), verification scores, atomic publish and pruning,
Range server. **Not tested yet:** the viewer in a real browser (WebGL shader, screen-space rendering under the map, particles), and `pipeline.py` on the GPU machine with real data. Unit conventions for real zarr outputs (precipitation
mm/h, geopotential m²/s²) are assumed from appa-live; `ZarrSource` logs a warning if `units` attributes disagree.

## Next

* In-memory ensemble: decode members straight to GPU tensors instead of per-member zarr (the one remaining disk round trip).
* Overlap stages: fetch/encode the next cycle while building the current one.
* Isobar contours (marching squares in the shader or from the 16-bit pressure field), time-aggregate fields (24 h rain).
