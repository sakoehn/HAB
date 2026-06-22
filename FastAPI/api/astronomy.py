"""
astronomy.py
------------
Sunrise / sunset computation and sun-times cache.

The tide data itself is loaded by cache.py (TIDES).  This module is
responsible only for the solar geometry calculations and for building the
SUN_TIMES dict that /sun-times returns.

Algorithm: NOAA / Almanac for Computers (1990) — standard astronomical
sunrise-sunset formula, accurate to within a few minutes for latitudes
between 70°S and 70°N.

All times are converted from UTC to the PDT (UTC-7) convention used by
JGI_ID_Timepoints_128.csv so callers can compare them directly against
sample timestamps without further conversion.
"""

import math

from .config import LOCATION_LAT, LOCATION_LON, LOCATION_TZ_OFFSET
from .index import DATA_DATE_MAX, DATA_DATE_MIN


# ── Core astronomy ────────────────────────────────────────────────────────────

def sunrise_sunset_utc(
    date: "datetime.date",
    lat: float,
    lon: float,
) -> tuple[float | None, float | None]:
    """
    Compute sunrise and sunset (decimal hours, UTC) for a date and location.

    Uses the NOAA / Almanac for Computers (1990) algorithm.

    Returns (sunrise_utc, sunset_utc) as decimal hours in [0, 24), or
    (None, None) when the sun does not rise/set on that date at that
    latitude (polar day/night — not expected at 48.65°N in May–June).
    """
    n        = date.timetuple().tm_yday
    lng_hour = lon / 15

    def _calc(is_sunrise: bool) -> float | None:
        t  = n + ((6 - lng_hour) / 24 if is_sunrise else (18 - lng_hour) / 24)
        m  = (0.9856 * t) - 3.289
        l  = m + (1.916 * math.sin(math.radians(m))) + (0.020 * math.sin(math.radians(2 * m))) + 282.634
        l  = l % 360
        ra = math.degrees(math.atan(0.91764 * math.tan(math.radians(l)))) % 360

        l_quadrant  = math.floor(l  / 90) * 90
        ra_quadrant = math.floor(ra / 90) * 90
        ra          = (ra + (l_quadrant - ra_quadrant)) / 15

        sin_dec = 0.39782 * math.sin(math.radians(l))
        cos_dec = math.cos(math.asin(sin_dec))
        cos_h   = (
            math.cos(math.radians(90.833)) - (sin_dec * math.sin(math.radians(lat)))
        ) / (cos_dec * math.cos(math.radians(lat)))

        if not (-1 <= cos_h <= 1):
            return None  # sun never rises / never sets on this date

        h       = (360 - math.degrees(math.acos(cos_h))) if is_sunrise else math.degrees(math.acos(cos_h))
        h       = h / 15
        t_local = h + ra - (0.06571 * t) - 6.622
        return (t_local - lng_hour) % 24

    return _calc(True), _calc(False)


# ── Sun-times cache ───────────────────────────────────────────────────────────

def _build_sun_times() -> dict[str, dict[str, str]]:
    """
    Compute sunrise / sunset for every date in [DATA_DATE_MIN, DATA_DATE_MAX]
    at LOCATION_LAT / LOCATION_LON, converting from UTC to the local PDT
    convention (LOCATION_TZ_OFFSET = -7).

    Returns { "YYYY-MM-DD": { "sunrise": "HH:MM", "sunset": "HH:MM" } }.
    Dates where sunrise_sunset_utc returns None are omitted (not expected at
    this latitude/season, but handled defensively).
    """
    from datetime import datetime as _dt, timedelta as _td

    if not DATA_DATE_MIN or not DATA_DATE_MAX:
        return {}

    start = _dt.strptime(DATA_DATE_MIN, "%Y-%m-%d").date()
    end   = _dt.strptime(DATA_DATE_MAX, "%Y-%m-%d").date()

    def _fmt_local(utc_hours: float) -> str:
        local = (utc_hours + LOCATION_TZ_OFFSET) % 24
        hh    = int(local)
        mm    = int(round((local - hh) * 60))
        if mm == 60:
            mm = 0
            hh = (hh + 1) % 24
        return f"{hh:02d}:{mm:02d}"

    result: dict[str, dict[str, str]] = {}
    d = start
    while d <= end:
        rise_utc, set_utc = sunrise_sunset_utc(d, LOCATION_LAT, LOCATION_LON)
        if rise_utc is not None and set_utc is not None:
            result[d.strftime("%Y-%m-%d")] = {
                "sunrise": _fmt_local(rise_utc),
                "sunset":  _fmt_local(set_utc),
            }
        d += _td(days=1)

    return result


# Computed once at import time; read-only at runtime.
SUN_TIMES: dict[str, dict[str, str]] = _build_sun_times()
