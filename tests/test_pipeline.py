import json
import numpy as np
import pytest

from appa_live2 import encode, build, points, verify
from appa_live2.sources import SyntheticSource


def test_quantize_roundtrip_8_and_16():
    x = np.random.default_rng(0).uniform(250, 310, (50, 80)).astype(np.float32)
    for bits, tol in ((8, 60 / 254 / 2 + 1e-4), (16, 60 / 65534 / 2 + 1e-4)):
        lo, hi = 250.0, 310.0
        q = encode.quantize(x, lo, hi, bits)
        blob = encode.png_bytes(q, bits)
        back = encode.dequantize(encode.decode_png(blob, bits), lo, hi, bits)
        assert np.abs(back - x).max() <= tol * 1.01


def test_sqrt_transform_keeps_zero_exact():
    x = np.array([[0.0, 0.5, 4.0]], np.float32)
    lo, hi = encode.full_range(x, "sqrt")
    back = encode.dequantize(encode.quantize(x, lo, hi, 8, "sqrt"), lo, hi, 8, "sqrt")
    assert back[0, 0] == 0.0 and abs(back[0, 2] - 4.0) < 0.05


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out = tmp_path_factory.mktemp("data")
    src = SyntheticSource(n_members=3, n_times=5, height=37, width=72)
    final = build.build_run(src, out, keep_runs=2)
    return out, final, src


def test_publish_layout(run):
    out, final, src = run
    latest = json.loads((out / "latest.json").read_text())
    assert latest["manifest"] == f"runs/{final.name}/manifest.json"
    m = json.loads((out / latest["manifest"]).read_text())
    assert not list((out / "runs").glob(".*partial"))
    assert m["grid"]["width"] == 72 and len(m["valid_times"]) == 5
    # every frame offset/length stays inside its pack file and is a valid PNG
    for prod, fields in m["fields"].items():
        for fid, e in fields.items():
            data = (final / e["file"]).read_bytes()
            assert len(e["frames"]) == 5
            for off, ln in e["frames"]:
                assert data[off:off + 8] == b"\x89PNG\r\n\x1a\n" and off + ln <= len(data)
    assert "mean" in m["fields"] and "prob_hot" in m["fields"]
    assert set(m["wind"]) == {"10m"} | {str(l) for l in m["levels"]}


def test_mean_field_matches_numpy(run):
    out, final, src = run
    m = json.loads((final / "manifest.json").read_text())
    e = m["fields"]["mean"]["2m_temperature"]
    off, ln = e["frames"][2]
    q = encode.decode_png((final / e["file"]).read_bytes()[off:off + ln], e["bits"])
    got = encode.dequantize(q, *e["range"], e["bits"])
    want = src.raw("2m_temperature", None).mean(0)[2]
    assert np.abs(got - want).max() <= (e["range"][1] - e["range"][0]) / 65535 / 2 * 1.01
    # the quantisation range covers every value (no clipping of extremes)
    assert e["range"][0] <= want.min() and e["range"][1] >= want.max()
    assert e["range"][0] <= e["display_range"][0] < e["display_range"][1] <= e["range"][1]


def test_derived_wind_speed_is_mean_of_speeds(run):
    out, final, src = run
    m = json.loads((final / "manifest.json").read_text())
    e = m["fields"]["mean"]["10m_wind_speed"]
    off, ln = e["frames"][0]
    got = encode.dequantize(encode.decode_png((final / e["file"]).read_bytes()[off:off + ln], e["bits"]), *e["range"], e["bits"])
    u, v = src.raw("10m_u_component_of_wind", None), src.raw("10m_v_component_of_wind", None)
    want = np.hypot(u, v).mean(0)[0]
    assert np.abs(got - want).max() < (e["range"][1] - e["range"][0]) / 255 + 1e-3
    # and it is NOT the speed of the mean wind (which would be smaller)
    assert want.mean() > np.hypot(u.mean(0), v.mean(0))[0].mean()


def test_probability_field_in_unit_range(run):
    out, final, src = run
    m = json.loads((final / "manifest.json").read_text())
    e = m["fields"]["prob_freeze"]["2m_temperature"]
    off, ln = e["frames"][0]
    q = encode.decode_png((final / e["file"]).read_bytes()[off:off + ln], 8)
    assert e["range"] == [0.0, 1.0] and q.max() <= 255
    t = src.raw("2m_temperature", None)[:, 0]
    want = (t < 273.15).mean(0)
    assert np.abs(encode.dequantize(q, 0.0, 1.0, 8) - want).max() <= 0.5 / 254 + 1e-6


def test_points_roundtrip_and_prune(run):
    out, final, src = run
    m = json.loads((final / "manifest.json").read_text())
    e = m["points"]["2m_temperature"]
    raw = src.raw("2m_temperature", None)
    for y, x in [(0, 0), (18, 35), (36, 71)]:
        got = points.read_point(final / e["file"], e, y, x)
        assert got.shape == (3, 5)
        assert np.abs(got - raw[:, :, y, x]).max() < (e["range"][1] - e["range"][0]) / 65535 * 1.01


def test_verification_perfect_and_biased(run):
    out, final, src = run
    mean_truth = {}

    def analysis(var, level, times):
        return src.raw(var, level).mean(0)

    res = verify.verify_run(final, analysis)
    f = res["fields"]["2m_temperature"]
    assert max(abs(b) for b in f["bias"]) < 0.01          # truth == ensemble mean
    assert all(r < 0.01 for r in f["rmse"])

    res = verify.verify_run(final, lambda v, l, t: src.raw(v, l).mean(0) + 2.0)
    f = res["fields"]["2m_temperature"]
    assert np.allclose(f["bias"], -2.0, atol=0.01) and np.allclose(f["rmse"], 2.0, atol=0.01)


def test_crps_matches_mae_for_single_member():
    y = np.zeros((4, 4), np.float32)
    m = np.full((1, 4, 4), 3.0, np.float32)
    assert np.allclose(verify.crps_ensemble(m, y), 3.0)


def test_point_stride(tmp_path):
    import torch
    m = torch.rand(2, 3, 37, 72)
    e = points.write_points(tmp_path / "p.u16", m, stride=4)
    assert (e["height"], e["width"], e["stride"]) == (10, 18, 4)
    got = points.read_point(tmp_path / "p.u16", e, 3, 5)
    assert np.abs(got - m[:, :, 12, 20].numpy()).max() < 1e-4
    with pytest.raises(ValueError):
        points.write_points(tmp_path / "q.u16", m, stride=5)


def test_js_decoders_agree_with_python(tmp_path):
    import shutil, subprocess, torch
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    m = torch.rand(3, 4, 37, 72) * 50 + 250
    e = points.write_points(tmp_path / "p.u16", m, stride=2)
    coords = [[0, 0], [5, 7], [35, 18]]
    out = subprocess.run([node, "tests/js/check.mjs", str(tmp_path / "p.u16"), json.dumps(e), json.dumps(coords)],
                         capture_output=True, text=True, check=True).stdout
    js = json.loads(out)
    for (x, y), rec in zip(coords, js["records"]):
        want = points.read_point(tmp_path / "p.u16", e, y, x)
        assert np.abs(np.array(rec).reshape(3, 4) - want).max() < 1e-4
    # grid helpers: pole/dateline/wraparound cases
    # (-180,90) corner; (0,0); 179.9E is nearer to column 0 (=180E) than to 179.75E, so it wraps;
    # -190 == 170E -> column 1400; latitude 95 clamps to the pole row.
    assert js["grid"]["idx"] == [{"x": 0, "y": 0}, {"x": 720, "y": 360}, {"x": 0, "y": 720}, {"x": 1400, "y": 0}]
    assert js["grid"]["ll"] == {"lon": 0, "lat": 0}
    # polynomial turbo: dark at 0, bright green-yellow in the middle, dark red at 1
    (r0, g0, b0, _), (r1, g1, b1, _), (r2, g2, b2, _) = js["turbo"]
    assert max(r0, g0, b0) < 80 and g1 > 200 and r2 > 100 and g2 < 30 and b2 < 30
    assert js["lutLen"] == 1024


def test_single_member_runs_only_publish_mean(tmp_path):
    class OneMember(SyntheticSource):
        kind = "analysis"
    src = OneMember(n_members=1, n_times=3, height=19, width=36)
    final = build.build_run(src, tmp_path, keep_runs=1, point_stride=2)
    m = json.loads((final / "manifest.json").read_text())
    assert list(m["fields"]) == ["mean"] and m["kind"] == "analysis" and m["members"] == 1


def test_missing_values_are_code_zero_and_json_is_valid(tmp_path):
    x = np.array([[1.0, np.nan], [3.0, 2.0]], np.float32)
    lo, hi = encode.full_range(x, "linear")
    assert (lo, hi) == (1.0, 3.0) and encode.display_range(x) == pytest.approx((1.002, 2.998), abs=1e-3)
    q = encode.quantize(x, lo, hi, 8)
    assert q[0, 1] == 0 and q[0, 0] == 1 and q[1, 0] == 255      # valid data never uses code 0
    back = encode.dequantize(q, lo, hi, 8)
    assert np.isnan(back[0, 1]) and np.allclose(back[~np.isnan(back)], x[~np.isnan(x)])

    class WithLand(SyntheticSource):
        def raw(self, var, level):
            a = super().raw(var, level)
            if var == "sea_surface_temperature":
                a[..., :10, :] = np.nan                          # "land" rows
            return a
    final = build.build_run(WithLand(2, 3, 19, 36), tmp_path, keep_runs=1)
    m = json.loads((final / "manifest.json").read_text(), parse_constant=lambda c: pytest.fail(f"{c} in manifest"))
    e = m["fields"]["mean"]["sea_surface_temperature"]
    off, ln = e["frames"][0]
    code = encode.decode_png((final / e["file"]).read_bytes()[off:off + ln], e["bits"])
    assert (code[:10] == 0).all() and (code[10:] > 0).all()
    assert all(np.isfinite(e["range"])) and e["range"][1] > e["range"][0]


def test_js_contouring_known_answers():
    import shutil, subprocess
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    r = json.loads(subprocess.run([node, "tests/js/contours_check.mjs"], capture_output=True, text=True, check=True).stdout)
    assert r["circle"]["nLines"] == 1 and r["circle"]["closed"] and r["circle"]["maxRadiusError"] < 0.02
    assert r["ramp"]["nLines"] == 1 and r["ramp"]["xs"] == [10.5] and r["ramp"]["nPts"] == 20
    assert r["saddle"]["nLines"] == 2                       # no self-crossing tangle
    assert r["nan"]["nLinesThroughHole"] == 0 and r["nan"]["nLines"] == 1
    assert r["extrema"] == [{"type": "H", "i": 118, "j": 20, "value": 1031}, {"type": "L", "i": 60, "j": 40, "value": 983}]
    (x0, y0), (x1, y1), (x2, y2) = r["mercator"]
    assert (x0, y0) == (0.5, 0.5) and x1 == 0 and x2 == 1 and abs(y1) < 1e-9 and abs(y2) < 1e-9


def test_js_legend_ticks():
    import shutil, subprocess
    node = shutil.which("node")
    if not node:
        pytest.skip("node not installed")
    r = json.loads(subprocess.run([node, "tests/js/legend_check.mjs"], capture_output=True, text=True, check=True).stdout)
    assert r["temp"]["v"] == [-60, -40, -20, 0, 20, 40] and r["temp"]["labels"][0] == "−60"   # real minus sign
    assert r["rain"]["v"] == [0, 1, 2, 3, 4, 5] and r["prob"]["v"][-1] == 100
    assert r["small"]["labels"] == ["0.00", "0.05", "0.10", "0.15", "0.20", "0.25", "0.30"]       # decimals match the step
    assert r["decimals"] == [1, 2, 0, 1] and r["neg0"] == "0" and r["minus"] == "−12.5"
    assert r["sqrt"][0] == 0 and r["sqrt"] == sorted(r["sqrt"]) and len(r["sqrtBig"]) <= 9


def test_natural_earth_lines_never_jump_across_the_map():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    import clean_natural_earth as c

    # Fiji's real coastline crosses the antimeridian: -180 -> +179.36 must become a short step.
    line = c.unwrap_line([[-179.92, -16.5], [-180, -16.56], [179.36, -16.8], [180, -16.07], [-180, -16.07]])
    assert max(abs(b[0] - a[0]) for a, b in zip(line, line[1:])) < 1.0
    assert c.unwrap_line([[10, 0], [10, 0], [11, 1]]) == [[10, 0], [11, 1]]       # zero-length steps dropped
    assert c.unwrap_line(c.unwrap_line(line)) == line                              # idempotent

    root = Path(__file__).resolve().parent.parent / "web" / "vendor"
    for name in ("coast", "borders"):
        lines = json.loads((root / f"{name}.json").read_text())["geometry"]["coordinates"]
        worst = max(abs(b[0] - a[0]) for l in lines for a, b in zip(l, l[1:]))
        assert worst < 30, f"{name}: a segment spans {worst} degrees of longitude"
