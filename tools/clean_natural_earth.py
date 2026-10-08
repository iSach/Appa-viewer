"""Make the vendored Natural Earth lines safe to draw on a wrapping Web Mercator map.

The source geometry (npm `world-atlas` 110m, converted with topojson-client `mesh`) jumps from
lon +180 to lon -180 where a coastline crosses the antimeridian (Fiji, Chukotka, Wrangel Island,
the closing of Antarctica). A renderer draws that jump as one straight line across the entire map.

Fix: unwrap longitudes so every line is continuous (it may run slightly past +-180); MapLibre then
draws it correctly through its world copies. Idempotent. Run:  python tools/clean_natural_earth.py
"""
import json
from pathlib import Path

VENDOR = Path(__file__).resolve().parent.parent / "web" / "vendor"


def unwrap_line(line):
    """Shift each longitude by a multiple of 360 so consecutive points are < 180 degrees apart."""
    out = [list(line[0])]
    for x, y in line[1:]:
        px = out[-1][0]
        while x - px > 180:
            x -= 360
        while x - px < -180:
            x += 360
        if [x, y] != out[-1]:            # drop zero-length steps (e.g. the +180 -> -180 ring closure)
            out.append([round(x, 2), y])
    return out


def clean_geometry(geometry):
    lines = [unwrap_line(l) for l in geometry["coordinates"]]
    geometry["coordinates"] = [l for l in lines if len(l) >= 2]
    return geometry


def main():
    for name in ("coast", "borders"):
        path = VENDOR / f"{name}.json"
        data = json.loads(path.read_text())
        clean_geometry(data["geometry"])
        path.write_text(json.dumps(data, separators=(",", ":")))
        print(f"cleaned {path.name}: {len(data['geometry']['coordinates'])} lines")


if __name__ == "__main__":
    main()
