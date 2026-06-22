#!/usr/bin/env python3
"""
test_tides_and_suntimes.py
───────────────────────────────────────────────────────────────────────────
Standalone verification script for the tide/day-night backend additions
(see backend_tides_suntimes.patch.md). Runs WITHOUT starting the FastAPI
app — reads tides.csv and JGI_ID_Timepoints_128.csv directly from
DataStructures/, mirrors the loader + sunrise/sunset logic from main.py,
and prints a verification report.

USAGE
    python3 test_tides_and_suntimes.py [--data-dir PATH]

    --data-dir defaults to "../DataStructures" relative to this script's
    location (i.e. assumes this script lives in Tests/ or similar next to
    DataStructures/). Override if your layout differs.

WHAT THIS CHECKS
  1. tides.csv loads correctly (skips comment lines, parses predicted_wl,
     captures tide_event High/Low markers).
  2. Sunrise/sunset computation matches expected values for known dates
     at 48.65N, -122.85W (sanity bounds, not exact-second precision).
  3. SUN_TIMES covers the full timepoints date range with no gaps.
  4. TIMEZONE CHECK: compares a tide_event "Low"/"High" timestamp against
     the computed sun-times' implied day boundary, to help confirm whether
     tides.csv's "lst" timezone is PST (UTC-8) as assumed, or matches the
     timepoints CSV's apparent PDT (UTC-7) — flags the 1-hour discrepancy
     either way so a human can confirm against an independent tide table.
  5. Spot-checks that EGC timepoint timestamps fall within
     [sunrise, sunset) or outside it as expected, printing a small
     day/night classification table for the first few days.
  6. REGRESSION CHECK for the _compute_date_range() string-sort bug
     (found 2026-06-15): confirms the timepoints date range is computed
     by sorting PARSED datetimes, not raw strings. Demonstrates the bug
     directly by showing what the (wrong) string-sort result would have
     been, and asserts the correct max date is reached.
"""

import argparse
import csv
import math
import os
import sys
from datetime import datetime, timedelta, date


# ── Constants (mirrors main.py) ─────────────────────────────────────────────

LOCATION_LAT       = 48.65
LOCATION_LON       = -122.85
LOCATION_NAME      = "Rosario, Orcas Island, WA"
LOCATION_TZ_OFFSET = -7   # PDT, matches timepoints CSV
TIDE_TZ_OFFSET     = -8   # PST/LST, matches tides.csv header


# ── Loaders (mirrors main.py) ────────────────────────────────────────────────

def load_tides(path: str) -> list[dict]:
    if not os.path.exists(path):
        print(f"  [MISSING] {path} not found.")
        return []

    with open(path, "r") as f:
        lines = [line for line in f if not line.startswith("#")]

    reader = csv.DictReader(lines)
    rows = []
    for row in reader:
        wl = (row.get("predicted_wl") or "").strip()
        if not wl:
            continue
        try:
            predicted_wl = float(wl)
        except ValueError:
            continue
        rows.append({
            "time":         row["time"].strip(),
            "predicted_wl": predicted_wl,
            "tide_event":   (row.get("tide_event") or "").strip() or None,
        })
    return rows


def load_timepoints(path: str) -> dict:
    if not os.path.exists(path):
        print(f"  [MISSING] {path} not found.")
        return {}

    timepoints = {}
    with open(path, "r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sample = row["taxon_oid"]
            timepoints[sample] = {
                "taxon_oid": row["taxon_oid"],
                "timepoint": row["Timepoint"],
                "datetime":  row["DateTime"],
            }
    return timepoints


# ── Sunrise/sunset (mirrors main.py _sunrise_sunset_utc) ────────────────────

def sunrise_sunset_utc(d: date, lat: float, lon: float) -> tuple[float | None, float | None]:
    n = d.timetuple().tm_yday
    lng_hour = lon / 15

    def calc(is_sunrise: bool) -> float | None:
        t = n + ((6 - lng_hour) / 24 if is_sunrise else (18 - lng_hour) / 24)
        m = (0.9856 * t) - 3.289
        l = m + (1.916 * math.sin(math.radians(m))) + (0.020 * math.sin(math.radians(2 * m))) + 282.634
        l = l % 360
        ra = math.degrees(math.atan(0.91764 * math.tan(math.radians(l))))
        ra = ra % 360
        l_quadrant  = math.floor(l / 90) * 90
        ra_quadrant = math.floor(ra / 90) * 90
        ra = (ra + (l_quadrant - ra_quadrant)) / 15
        sin_dec = 0.39782 * math.sin(math.radians(l))
        cos_dec = math.cos(math.asin(sin_dec))
        cos_h = (
            math.cos(math.radians(90.833)) - (sin_dec * math.sin(math.radians(lat)))
        ) / (cos_dec * math.cos(math.radians(lat)))
        if cos_h > 1 or cos_h < -1:
            return None
        h = (360 - math.degrees(math.acos(cos_h))) if is_sunrise else math.degrees(math.acos(cos_h))
        h = h / 15
        t_local = h + ra - (0.06571 * t) - 6.622
        return (t_local - lng_hour) % 24

    return calc(True), calc(False)


def fmt_local(utc_hours: float, tz_offset: int) -> str:
    local = (utc_hours + tz_offset) % 24
    hh = int(local)
    mm = int(round((local - hh) * 60))
    if mm == 60:
        mm = 0
        hh = (hh + 1) % 24
    return f"{hh:02d}:{mm:02d}"


def build_sun_times(date_min: str, date_max: str, tz_offset: int) -> dict[str, dict[str, str]]:
    start = datetime.strptime(date_min, "%Y-%m-%d").date()
    end   = datetime.strptime(date_max, "%Y-%m-%d").date()

    result = {}
    d = start
    while d <= end:
        sr_utc, ss_utc = sunrise_sunset_utc(d, LOCATION_LAT, LOCATION_LON)
        if sr_utc is not None and ss_utc is not None:
            result[d.strftime("%Y-%m-%d")] = {
                "sunrise": fmt_local(sr_utc, tz_offset),
                "sunset":  fmt_local(ss_utc, tz_offset),
            }
        d += timedelta(days=1)
    return result


# ── Timepoint datetime parsing (handles unpadded "M/D/YY H:MM") ─────────────

def parse_timepoint_dt(dt_str: str) -> datetime:
    """Parse 'M/D/YY H:MM' (unpadded) into a datetime."""
    date_part, time_part = dt_str.split(" ")
    m, d, y = date_part.split("/")
    h, mi   = time_part.split(":")
    year = int(y) + 2000 if int(y) < 100 else int(y)
    return datetime(year, int(m), int(d), int(h), int(mi))


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        default=os.path.join(os.path.dirname(__file__), "..", "DataStructures"),
        help="Path to DataStructures/ (default: ../DataStructures relative to this script)",
    )
    args = parser.parse_args()

    data_dir   = os.path.abspath(args.data_dir)
    tides_path = os.path.join(data_dir, "tides.csv")
    tp_path    = os.path.join(data_dir, "JGI_ID_Timepoints_128.csv")

    print("=" * 78)
    print("TIDE + DAY/NIGHT VERIFICATION")
    print("=" * 78)
    print(f"Data dir:   {data_dir}")
    print(f"Location:   {LOCATION_NAME} ({LOCATION_LAT}N, {LOCATION_LON}W)")
    print()

    # ── 1. Load tides ────────────────────────────────────────────────────
    print("-" * 78)
    print("1. TIDE DATA LOAD")
    print("-" * 78)
    tides = load_tides(tides_path)
    if not tides:
        print("  No tide data loaded — cannot continue tide-related checks.")
        sys.exit(1)

    print(f"  Loaded {len(tides)} tide rows")
    print(f"  First: {tides[0]}")
    print(f"  Last:  {tides[-1]}")

    wls = [r["predicted_wl"] for r in tides]
    print(f"  predicted_wl range: {min(wls):.4f} to {max(wls):.4f} meters")

    events = [r for r in tides if r["tide_event"]]
    print(f"  Rows with tide_event (High/Low): {len(events)}")
    for e in events[:6]:
        print(f"    {e['time']}  {e['tide_event']:>4}  wl={e['predicted_wl']:.4f}")
    if len(events) > 6:
        print(f"    ... and {len(events) - 6} more")
    print()

    # ── 2. Load timepoints, compute date range ──────────────────────────
    print("-" * 78)
    print("2. TIMEPOINTS DATE RANGE")
    print("-" * 78)
    timepoints = load_timepoints(tp_path)
    if not timepoints:
        print("  No timepoints loaded — cannot continue date-range checks.")
        sys.exit(1)

    parsed = []
    for tp in timepoints.values():
        try:
            parsed.append(parse_timepoint_dt(tp["datetime"]))
        except Exception as e:
            print(f"  [WARN] could not parse datetime {tp['datetime']!r}: {e}")

    parsed.sort()
    date_min = parsed[0].strftime("%Y-%m-%d")
    date_max = parsed[-1].strftime("%Y-%m-%d")
    print(f"  {len(parsed)} samples")
    print(f"  Earliest: {parsed[0]}  ({date_min})")
    print(f"  Latest:   {parsed[-1]}  ({date_max})")
    print()

    # ── 3. Sunrise/sunset for the date range ─────────────────────────────
    print("-" * 78)
    print("3. SUNRISE/SUNSET (PDT, to match timepoints)")
    print("-" * 78)
    sun_times = build_sun_times(date_min, date_max, LOCATION_TZ_OFFSET)
    print(f"  Computed {len(sun_times)} days, expected "
          f"{(datetime.strptime(date_max, '%Y-%m-%d') - datetime.strptime(date_min, '%Y-%m-%d')).days + 1}")

    expected_days = (datetime.strptime(date_max, "%Y-%m-%d") - datetime.strptime(date_min, "%Y-%m-%d")).days + 1
    if len(sun_times) != expected_days:
        print(f"  [WARN] gap detected — {expected_days - len(sun_times)} day(s) missing from SUN_TIMES")
    else:
        print("  No gaps — every date in range has sunrise/sunset.")

    print()
    print("  First 5 days:")
    for d_str in sorted(sun_times)[:5]:
        st = sun_times[d_str]
        print(f"    {d_str}  sunrise {st['sunrise']}  sunset {st['sunset']}")

    print()
    print("  Sanity bounds check (May-June at 48.65N: sunrise ~04:50-05:20,")
    print("  sunset ~20:55-21:15 PDT expected):")
    bad = []
    for d_str, st in sun_times.items():
        sr_h, sr_m = map(int, st["sunrise"].split(":"))
        ss_h, ss_m = map(int, st["sunset"].split(":"))
        sr_dec = sr_h + sr_m / 60
        ss_dec = ss_h + ss_m / 60
        if not (4.5 <= sr_dec <= 5.5):
            bad.append((d_str, "sunrise", st["sunrise"]))
        if not (20.5 <= ss_dec <= 21.5):
            bad.append((d_str, "sunset", st["sunset"]))
    if bad:
        print(f"  [WARN] {len(bad)} value(s) outside expected bounds:")
        for d_str, which, val in bad[:10]:
            print(f"    {d_str} {which} = {val}")
    else:
        print("  All sunrise/sunset values within expected bounds. ✓")
    print()

    # ── 4. Timezone alignment check ──────────────────────────────────────
    print("-" * 78)
    print("4. TIMEZONE ALIGNMENT CHECK (tides.csv 'lst' vs timepoints PDT)")
    print("-" * 78)
    print("  tides.csv header declares Timezone: lst (assumed PST, UTC-8).")
    print("  Timepoints CSV is assumed PDT (UTC-7) for this May-June dataset.")
    print("  If both assumptions are correct, a tide event timestamped")
    print("  HH:MM in tides.csv corresponds to (HH+1):MM in timepoints-time.")
    print()
    print("  Tide High/Low events near midday (for visual cross-check against")
    print("  an independent tide table for Rosario, Orcas Island):")
    for e in events[:10]:
        # naive +1h shift to show what this would look like in PDT/timepoints time
        try:
            t = datetime.strptime(e["time"], "%Y-%m-%d %H:%M")
            shifted = t + timedelta(hours=1)
            print(f"    tides.csv: {e['time']} ({e['tide_event']})  "
                  f"-> if shifted +1h (PDT): {shifted.strftime('%Y-%m-%d %H:%M')}")
        except ValueError:
            pass
    print()
    print("  ACTION: manually compare one of the above 'tides.csv' times")
    print("  against a known tide table (e.g. tidesandcurrents.noaa.gov for")
    print("  station 9449771) to confirm whether tides.csv times are PST")
    print("  (no shift needed when comparing PST tide time to UTC) or need")
    print("  the +1h shift to align with timepoints' apparent PDT.")
    print()

    # ── 5. Day/night classification of actual EGC timepoints ────────────
    print("-" * 78)
    print("5. DAY/NIGHT CLASSIFICATION — first 3 days of timepoints")
    print("-" * 78)
    shown_days = set()
    for dt in parsed:
        d_str = dt.strftime("%Y-%m-%d")
        if d_str not in sun_times:
            continue
        if len(shown_days) >= 3 and d_str not in shown_days:
            continue
        shown_days.add(d_str)

    for d_str in sorted(shown_days):
        st = sun_times[d_str]
        print(f"  {d_str}  (sunrise {st['sunrise']}, sunset {st['sunset']})")
        day_pts = [dt for dt in parsed if dt.strftime("%Y-%m-%d") == d_str]
        for dt in day_pts:
            tstr = dt.strftime("%H:%M")
            is_day = st["sunrise"] <= tstr < st["sunset"]
            label = "day  " if is_day else "night"
            print(f"    {dt.strftime('%H:%M')}  -> {label}")
    print()

    # ── 6. Regression check — _compute_date_range() string-sort bug ──────
    print("-" * 78)
    print("6. DATE-RANGE REGRESSION CHECK (_compute_date_range string-sort bug)")
    print("-" * 78)
    print("  Bug found 2026-06-15: main.py's _compute_date_range() sorted raw")
    print("  datetime STRINGS instead of parsed values. JGI_ID_Timepoints_128.csv")
    print("  is unpadded ('M/D/YY H:MM', e.g. '6/2/21 1:00'), so a string sort")
    print("  is wrong whenever a single-digit day/month is compared against a")
    print("  double-digit one starting with a smaller first character (e.g.")
    print("  '6/9/21' > '6/18/21' as strings, even though June 9 < June 18).")
    print()
    print("  This check demonstrates the bug directly using the live raw")
    print("  datetime strings, then confirms the CORRECT (parsed-datetime)")
    print("  result matches what /api/status should now report after the fix.")
    print()

    raw_strings = [tp["datetime"] for tp in timepoints.values() if tp.get("datetime")]

    # The WRONG way (reproduces the original bug, for documentation only)
    wrong_sorted   = sorted(raw_strings)
    wrong_date_max = wrong_sorted[-1]

    # The RIGHT way (parsed datetime sort — matches the fixed main.py)
    right_sorted   = sorted(raw_strings, key=parse_timepoint_dt)
    right_date_max = right_sorted[-1]

    print(f"  Buggy string-sort would give date_max raw string: {wrong_date_max!r}")
    print(f"  Correct parsed-sort gives date_max raw string:    {right_date_max!r}")
    print()

    right_date_max_iso = parse_timepoint_dt(right_date_max).strftime("%Y-%m-%d")
    print(f"  Correct date_max (ISO): {right_date_max_iso}")
    print(f"  Matches section 2's independently-computed date_max ({date_max})? "
          f"{'YES ✓' if right_date_max_iso == date_max else 'NO — MISMATCH, investigate'}")

    if wrong_date_max == right_date_max:
        print()
        print("  [INFO] In this dataset the buggy and correct sort happen to")
        print("  agree (no problematic digit-length boundary present in this")
        print("  particular run) — this does NOT mean the bug is absent from")
        print("  main.py, only that this data didn't trigger it. The fix should")
        print("  still be applied; do not rely on this check alone to rule out")
        print("  the bug for a different or expanded dataset.")
    else:
        print()
        print(f"  [CONFIRMED] String-sort bug reproduced: buggy result "
              f"({wrong_date_max!r}) differs from correct result "
              f"({right_date_max!r}). This is the exact bug fixed in "
              f"main.py's _compute_date_range() — verify /api/status "
              f"reports date_max = {right_date_max_iso}, not an earlier date.")
    print()

    print("=" * 78)
    print("DONE")
    print("=" * 78)


if __name__ == "__main__":
    main()