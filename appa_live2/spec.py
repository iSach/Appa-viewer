"""What gets published: variables, levels, products and display metadata.

Everything the viewer needs to know about a field (units, colormap, value
transform, precision) is declared here and copied into manifest.json, so the
viewer has no hardcoded knowledge of variables.
"""
from dataclasses import dataclass, field

PRESSURE_LEVELS = [50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000]

SURFACE_VARIABLES = [
    "2m_temperature",
    "10m_u_component_of_wind",
    "10m_v_component_of_wind",
    "mean_sea_level_pressure",
    "sea_surface_temperature",
    "total_precipitation",
]
ATMOSPHERIC_VARIABLES = [
    "temperature",
    "u_component_of_wind",
    "v_component_of_wind",
    "geopotential",
    "specific_humidity",
]


@dataclass(frozen=True)
class VarSpec:
    """Display metadata for one published variable.

    `unit_scale`/`unit_offset` convert model units to display units:
    shown = raw * unit_scale + unit_offset. The viewer applies them, the files
    always hold raw model units.
    """
    name: str
    label: str
    unit: str
    colormap: str
    unit_scale: float = 1.0
    unit_offset: float = 0.0
    transform: str = "linear"  # "linear" | "sqrt" (quantise in sqrt space, for rain)
    bits: int = 8              # 8 or 16 quantisation depth
    levels: bool = False       # True -> one field per pressure level
    transparent_below: float | None = None  # raw value under which pixels are see-through
    derived_from: tuple[str, ...] = ()


# NOTE: units below assume the same conventions as appa-live's zarr outputs
# (ERA5-style SI units, precipitation in mm/h from IMERG). ZarrSource logs a
# warning when a `units` attribute contradicts these; verify once on real data.
VARIABLES: dict[str, VarSpec] = {v.name: v for v in [
    VarSpec("2m_temperature", "2 m temperature", "°C", "turbo", unit_offset=-273.15, bits=16),
    VarSpec("sea_surface_temperature", "Sea surface temperature", "°C", "turbo", unit_offset=-273.15, bits=16),
    VarSpec("mean_sea_level_pressure", "Mean sea level pressure", "hPa", "pressure", unit_scale=0.01, bits=16),
    VarSpec("total_precipitation", "Precipitation", "mm/h", "rain", transform="sqrt", transparent_below=0.1),
    VarSpec("10m_wind_speed", "10 m wind speed", "m/s", "wind", derived_from=("10m_u_component_of_wind", "10m_v_component_of_wind")),
    VarSpec("temperature", "Temperature", "°C", "turbo", unit_offset=-273.15, bits=16, levels=True),
    VarSpec("geopotential", "Geopotential height", "gpm", "viridis", unit_scale=1 / 9.80665, bits=16, levels=True),
    VarSpec("specific_humidity", "Specific humidity", "g/kg", "humidity", unit_scale=1000.0, transform="sqrt", levels=True),
    VarSpec("wind_speed", "Wind speed", "m/s", "wind", levels=True, derived_from=("u_component_of_wind", "v_component_of_wind")),
    VarSpec("relative_humidity", "Relative humidity", "%", "humidity", levels=True, derived_from=("temperature", "specific_humidity")),
]}

# (u, v) variable pairs shipped as animated wind particle fields.
WIND_PAIRS = {
    None: ("10m_u_component_of_wind", "10m_v_component_of_wind"),
    "levels": ("u_component_of_wind", "v_component_of_wind"),
}


@dataclass(frozen=True)
class ProductSpec:
    """A statistic of the ensemble published as a raster field pack."""
    name: str                       # mean | std | p10 | p90 | prob_<x>
    label: str
    colormap: str | None = None     # overrides the variable's colormap
    variables: tuple[str, ...] | None = None  # None = every variable
    levels: tuple[int, ...] | None = None     # None = every level
    quantile: float | None = None
    # probability products: (variable, level, raw threshold, "above"|"below")
    threshold: tuple[str, int | None, float, str] | None = None


KEY_LEVELS = (250, 500, 850)
PRODUCTS = [
    ProductSpec("mean", "Ensemble mean"),
    ProductSpec("std", "Ensemble spread (std)", colormap="spread",
                variables=("2m_temperature", "mean_sea_level_pressure", "total_precipitation",
                           "10m_wind_speed", "temperature", "geopotential", "wind_speed"),
                levels=KEY_LEVELS),
    ProductSpec("p10", "10th percentile", quantile=0.10,
                variables=("2m_temperature", "total_precipitation", "10m_wind_speed")),
    ProductSpec("p90", "90th percentile", quantile=0.90,
                variables=("2m_temperature", "total_precipitation", "10m_wind_speed")),
    ProductSpec("prob_hot", "P(T2m > 30 °C)", colormap="prob",
                threshold=("2m_temperature", None, 303.15, "above")),
    ProductSpec("prob_freeze", "P(T2m < 0 °C)", colormap="prob",
                threshold=("2m_temperature", None, 273.15, "below")),
    ProductSpec("prob_rain", "P(rain > 1 mm/h)", colormap="prob",
                threshold=("total_precipitation", None, 1.0, "above")),
    ProductSpec("prob_gale", "P(wind > 17 m/s)", colormap="prob",
                threshold=("10m_wind_speed", None, 17.0, "above")),
]

# Fields for which every member is stored per grid point (click -> plume plot,
# and ensemble verification later on). Size per field is H*W*M*T*2 bytes.
POINT_FIELDS: list[tuple[str, int | None]] = [
    ("2m_temperature", None),
    ("10m_wind_speed", None),
    ("mean_sea_level_pressure", None),
    ("total_precipitation", None),
    ("temperature", 850),
    ("geopotential", 500),
]


def field_id(var: str, level: int | None) -> str:
    return var if level is None else f"{var}_{level}"
