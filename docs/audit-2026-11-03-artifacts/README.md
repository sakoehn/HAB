# Audit artifacts, 2026-11-03

Supporting material for `docs/AUDIT-2026-11-03-correctness.md`. Section 9 of that document describes every file here and which finding it supports.

- `reports/` — the seven reviewers' full reports.
- `correlation-perf/` — vectorised prototype (`fast_corr.py`), equality tests against `score_pair`, synthetic-db builder and benchmarks. `build_bench_db.py` writes a ~540 MB `bench.db` into this folder; the other scripts in the folder expect it there.
- `correlation-math/` — null and power simulations, exclusion fixtures, lag-sign check, gap arithmetic.
- `pipeline/` — KEGG BRITE experiments (need a downloaded `ko00001.keg`, passed as the first argument; not included).
- `api/` — fixtures reproducing the API findings and the query-plan checks.
- `frontend/` — two Vitest probe files (copy into `frontend/src/tests/` to run) and two live-check scripts.

Run Python scripts from their own folder with the repo's `.venv/bin/python`; each inserts `FastAPI/` (resolved relative to the file) into `sys.path`. Frontend probes need Node 24 on `PATH`.
