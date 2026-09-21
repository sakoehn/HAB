"""
index.py
--------
Datetime-sorting and date-range helpers shared by every route, plus
_INDEX_READY (set True once the sql connection is up -- see main.py's
lifespan()) which /status reports.
"""

from .cache import get_timepoint

_INDEX_READY = False


# ── Datetime sorting helpers ──────────────────────────────────────────────────

def _parse_any_datetime(dt_str: str):
    """
    Parse a datetime string that may be unpadded "M/D/YY H:MM" (as used in
    JGI_ID_Timepoints_128.csv), padded "MM/DD/YY HH:MM", ISO format, or a
    bare "YYYY-MM-DD" date (as sent by <input type="date"> pickers, e.g.
    /annotations/top's date_from/date_to).
    Returns a datetime object, or None if no format matches.
    """
    from datetime import datetime
    for fmt in ("%m/%d/%y %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(dt_str, fmt)
        except ValueError:
            continue
    return None


def timepoint_sort_key(sample_name: str) -> float:
    """
    Sort key for chronological ordering by timepoint datetime.

    Returns a Unix timestamp (float).  Returns -1.0 for samples with no
    timepoint so missing data sorts first predictably.

    IMPORTANT: never compare raw DateTime strings from JGI_ID_Timepoints_128.csv
    directly — they are unpadded ("M/D/YY H:MM") and sort incorrectly as
    plain strings (e.g. "6/9/21" > "6/18/21").
    """
    tp     = get_timepoint(sample_name)
    dt_str = (tp or {}).get("datetime")
    if not dt_str:
        return -1.0
    parsed = _parse_any_datetime(dt_str)
    return parsed.timestamp() if parsed is not None else -1.0


def timepoint_dt_sort_key(datetime_str: str | None) -> float:
    """
    Same as timepoint_sort_key but accepts a raw datetime string directly,
    for sorting result dicts that already carry a 'datetime' field.
    """
    if not datetime_str:
        return -1.0
    parsed = _parse_any_datetime(datetime_str)
    return parsed.timestamp() if parsed is not None else -1.0


def is_within_date_range(dt_str: str | None, date_from: str | None, date_to: str | None) -> bool:
    """
    True if a sample's raw datetime string falls within [date_from, date_to]
    (both bounds inclusive, either may be None/omitted).

    date_from/date_to are bare "YYYY-MM-DD" strings from the frontend's
    <input type="date"> pickers -- comparing them against dt_str as plain
    text is wrong, since dt_str is unpadded "M/D/YY H:MM"
    (e.g. "6/9/21 8:00" < "6/18/21 ..." lexically, even though June 9 is
    earlier than June 18). Both sides are parsed to datetime objects first.

    date_to is treated as covering the whole day (through 23:59:59), so a
    sample timestamped e.g. "6/5/21 21:00" still matches date_to=2021-06-05.
    A dt_str/date_from/date_to that fails to parse is treated as not
    matching that bound (dt_str: excluded entirely; a bound: that bound is
    ignored) rather than raising, since malformed input shouldn't 500 the
    endpoint.
    """
    dt = _parse_any_datetime(dt_str) if dt_str else None
    if dt is None:
        return False
    if date_from:
        from_dt = _parse_any_datetime(date_from)
        if from_dt is not None and dt < from_dt:
            return False
    if date_to:
        to_dt = _parse_any_datetime(date_to)
        if to_dt is not None and dt.date() > to_dt.date():
            return False
    return True


def compute_date_range() -> tuple[str, str] | tuple[None, None]:
    """
    Derive the ISO date range from TIMEPOINTS, sorting by parsed datetime
    rather than raw string to avoid the unpadded-date ordering bug.
    """
    from .cache import TIMEPOINTS

    datetimes = [tp["datetime"] for tp in TIMEPOINTS.values() if tp.get("datetime")]
    if not datetimes:
        return None, None

    parsed = [(s, _parse_any_datetime(s)) for s in datetimes]
    parsed = [(s, d) for s, d in parsed if d is not None]
    if not parsed:
        return None, None

    parsed.sort(key=lambda pair: pair[1])

    def _to_iso(dt_str: str) -> str:
        dt = _parse_any_datetime(dt_str)
        if dt is not None:
            return dt.strftime("%Y-%m-%d")
        return dt_str[:10] if len(dt_str) >= 10 else dt_str

    return _to_iso(parsed[0][0]), _to_iso(parsed[-1][0])


# Computed once at import time so /status and astronomy.py can read it cheaply.
DATA_DATE_MIN, DATA_DATE_MAX = compute_date_range()
