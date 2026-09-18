import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "FastAPI"))

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8000")


def _server_is_up() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/status", timeout=5.0)
        return r.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


def _sql_backend_active() -> bool:
    try:
        r = httpx.get(f"{API_BASE_URL}/sql-test", timeout=5.0)
        return r.status_code < 500
    except (httpx.ConnectError, httpx.TimeoutException) :
        return False

sql_route_required = pytest.mark.skipif(
    not (_server_is_up() and _sql_backend_active()),
    reason=(
        f"Server not reachable at {API_BASE_URL}, or not running with "
        "DATA_BACKEND=sql. Set DATA_BACKEND=sql in FastAPI/.env, "
        "start `uvicorn main:app --reload`, then re-run."
    ),
)

# Every test below takes a `client` parameter to receive this fixture's
# value -- pylint sees that as shadowing the module-level `client` name,
# but it's the standard pytest fixture-injection pattern, not a real bug.
# pylint: disable=redefined-outer-name

@pytest.fixture(scope="module")
def client():
    with httpx.Client(base_url=API_BASE_URL, timeout=30.0) as c:
        yield c


@sql_route_required
def test_sorted_results(client):
    resp = client.get("/annotations/top", params={"source": "cog", "limit": 10})
    resp.raise_for_status()
    data = resp.json()["data"]
    means = [row["mean_egc"] for row in data]
    assert len(data) == 10
    assert means == sorted(means, reverse=True)


@sql_route_required
def test_caching_consistency(client):
    resp_5 = client.get("/annotations/top", params={"source": "cog", "limit": 5})
    resp_5.raise_for_status()
    top_5 = resp_5.json()["data"]

    resp_20 = client.get("/annotations/top", params={"source": "cog", "limit": 20})
    resp_20.raise_for_status()
    top_20 = resp_20.json()["data"]

    assert top_20[:5] == top_5


@sql_route_required
def test_invalid_source(client):
    resp = client.get("/annotations/top", params={"source": "INVALID_SOURCE", "limit": 10})
    assert resp.status_code == 422


# W2: date_from/date_to were compared as plain text against the stored
# unpadded "M/D/YY H:MM" datetime, so a date_to always emptied the results
# and a date_from never filtered anything (the whole-dataset ranking came
# back mislabeled with the requested range, sample_count stuck at 128).
# All dates below are inside the real dataset's range (2021-05-27..2021-06-18,
# confirmed live via /status's date_min/date_max).

@sql_route_required
def test_date_to_no_longer_empties_the_results(client):
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_to": "2021-06-05"},
    )
    resp.raise_for_status()
    body = resp.json()
    assert body["data"], "date_to must not empty the results (W2 regression)"
    assert 0 < body["sample_count"] < 128


@sql_route_required
def test_date_from_actually_filters_and_is_not_identical_to_unfiltered(client):
    unfiltered = client.get("/annotations/top", params={"source": "cog", "limit": 10})
    unfiltered.raise_for_status()

    filtered = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 10, "date_from": "2021-06-15"},
    )
    filtered.raise_for_status()
    filtered_body = filtered.json()

    assert filtered_body["sample_count"] < unfiltered.json()["sample_count"], \
        "date_from must narrow sample_count below the unfiltered total (W2 regression)"
    assert filtered_body["sample_count"] < 128


@sql_route_required
def test_sample_count_reflects_the_active_filter_not_the_whole_dataset(client):
    resp = client.get(
        "/annotations/top",
        params={"source": "cog", "limit": 5, "date_from": "2021-05-27", "date_to": "2021-05-28"},
    )
    resp.raise_for_status()
    body = resp.json()
    # Independently verified against raw TIMEPOINTS: exactly 9 of the 128
    # samples fall within 2021-05-27..2021-05-28 inclusive.
    assert body["sample_count"] == 9
