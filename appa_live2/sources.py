"""Ensemble sources: anything that can hand over [members, time, lat, lon] arrays.

Grid convention for everything downstream: latitude descending (row 0 = north),
longitude ascending from -180 (column 0), so one image row/column order fits
the viewer.
"""
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import zlib

import numpy as np

from .spec import ATMOSPHERIC_VARIABLES, PRESSURE_LEVELS, SURFACE_VARIABLES

log = logging.getLogger(__name__)

RAW_VARIABLES = SURFACE_VARIABLES + ATMOSPHERIC_VARIABLES


class Source:
    kind = "forecast"  # "analysis" for ground-truth sources
    init_time: datetime
    times: list[datetime]
    n_members: int
    lat: np.ndarray
    lon: np.ndarray
    levels: list[int]

    def raw(self, var: str, level: int | None) -> np.ndarray:
        """Raw model variable as float32 [M, T, H, W]."""
        raise NotImplementedError


class SyntheticSource(Source):
    """Smooth fake weather with growing ensemble spread, for tests and demos."""

    def __init__(self, n_members=4, n_times=13, height=181, width=360, seed=0,
                 init_time: datetime | None = None):
        self.n_members, self.levels = n_members, list(PRESSURE_LEVELS)
        self.init_time = init_time or datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.times = [self.init_time + timedelta(hours=1 + i) for i in range(n_times)]
        self.lat = np.linspace(90, -90, height, dtype=np.float32)
        self.lon = (np.arange(width, dtype=np.float32) * (360.0 / width)) - 180.0
        self.seed = seed

    def _wave(self, rng, t):
        lat = np.deg2rad(self.lat)[:, None]
        lon = np.deg2rad(self.lon)[None, :]
        out = 0.0
        for k in (2, 3, 5):
            ph = rng.uniform(0, 2 * np.pi)
            out = out + np.sin(k * lon + ph + 0.05 * t) * np.cos(lat) ** 2 / k
        return out

    def raw(self, var, level):
        T, M = len(self.times), self.n_members
        lat = np.deg2rad(self.lat)[:, None]
        lon = np.deg2rad(self.lon)[None, :]
        out = np.empty((M, T, len(self.lat), len(self.lon)), np.float32)
        lvl = 0.0 if level is None else (np.log(level / 1000.0))
        for m in range(M):
            for t in range(T):
                # Same seed for every member -> same weather; members differ by
                # a perturbation that grows with lead time.
                rng = np.random.default_rng([self.seed, zlib.crc32(var.encode())])
                base = self._wave(rng, t)
                prng = np.random.default_rng([self.seed, m, t, zlib.crc32(var.encode())])
                noise = self._wave(prng, t) * (0.1 + 0.05 * t)
                f = base + noise
                if var in ("2m_temperature", "sea_surface_temperature"):
                    x = 288 + 25 * np.cos(lat) - 30 + 6 * f
                elif var == "temperature":
                    x = 288 + 25 * np.cos(lat) - 30 + 6 * f + 60 * lvl * 0.6
                elif var == "mean_sea_level_pressure":
                    x = 101325 + 1500 * f
                elif var == "geopotential":
                    x = 9.80665 * (-7000 * lvl + 80 * f * 10 + 150 * np.cos(lat))
                elif var == "specific_humidity":
                    x = 0.012 * np.cos(lat) ** 2 * np.exp(lvl * 1.5) * (1 + 0.4 * f)
                elif var == "total_precipitation":
                    x = np.maximum(0.0, 3 * f - 0.6) * np.cos(lat) ** 2
                elif var.endswith("u_component_of_wind"):
                    x = 25 * np.sin(2 * lat) * (1 + 0.6 * lvl) + 6 * f
                else:  # v component
                    x = 8 * np.cos(3 * lon) * np.cos(lat) + 6 * f
                out[m, t] = x
        return out


class ZarrSource(Source):
    """Per-member forecast zarrs as written by appa-live's decode_trajectory."""

    EXPECTED_UNITS = {"2m_temperature": "K", "mean_sea_level_pressure": "Pa", "temperature": "K"}

    def __init__(self, member_paths: list[Path], init_time: datetime | None = None):
        import xarray as xr
        self.datasets = [xr.open_zarr(p) for p in member_paths]
        ds0 = self.datasets[0]
        self.n_members = len(self.datasets)
        self.times = [t.replace(tzinfo=timezone.utc) for t in
                      np.array(ds0["time"].values).astype("datetime64[s]").astype(object)]
        self.init_time = init_time or (self.times[0] - timedelta(hours=1))
        self.levels = [int(x) for x in ds0["level"].values] if "level" in ds0.coords else []
        norm = self._normalise(ds0)
        self.lat, self.lon = norm["latitude"].values, norm["longitude"].values

    @staticmethod
    def _normalise(ds):
        lon = ((ds["longitude"] + 180) % 360) - 180
        return ds.assign_coords(longitude=lon).sortby("longitude").sortby("latitude", ascending=False)

    def raw(self, var, level):
        arrs = []
        for ds in self.datasets:
            da = ds[var]
            want = self.EXPECTED_UNITS.get(var)
            if want and da.attrs.get("units") not in (None, want):
                log.warning("%s has units %r, expected %r", var, da.attrs.get("units"), want)
            if level is not None:
                da = da.sel(level=level)
            arrs.append(self._normalise(da.to_dataset(name=var))[var].values.astype(np.float32))
        return np.stack(arrs)


class ERA5Source(Source):
    """ERA5 ground truth as a one-member "ensemble" (to try the viewer on real fields).

    Precipitation is converted from ERA5's accumulated metres per hour to mm/h.
    """
    kind = "analysis"

    def __init__(self, path: Path, start: int = 0, n_times: int = 13):
        import xarray as xr
        self.ds = xr.open_zarr(path)
        t = self.ds["time"].values[start:start + n_times]
        self.sl = slice(start, start + len(t))
        self.times = [x.replace(tzinfo=timezone.utc) for x in t.astype("datetime64[s]").astype(object)]
        self.init_time = self.times[0]
        self.n_members = 1
        self.levels = [int(x) for x in self.ds["level"].values]
        norm = ZarrSource._normalise(self.ds)
        self.lat, self.lon = norm["latitude"].values, norm["longitude"].values

    def raw(self, var, level):
        da = self.ds[var].isel(time=self.sl)
        if level is not None:
            da = da.sel(level=level)
        arr = ZarrSource._normalise(da.to_dataset(name=var))[var].values.astype(np.float32)
        if var == "total_precipitation":
            arr = arr * 1000.0  # m per hour -> mm/h
        return arr[None]
