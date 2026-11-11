# Measurements made while fixing section 4 (performance), 2026-11-11

Scripts and outputs behind section 10 of `docs/AUDIT-2026-11-03-correctness.md`.
They were written to answer one question each and are kept as a record of how
each number was produced, not as maintained tools: several hard-code paths on
the machine they ran on.

**Local** (Windows desktop, real 63.9 GB `hab_mappings.db`, data partly in memory)

- `baseline_real_db.py` → `baseline_real_db_results.txt`: today's correlation code before vectorising, six families, read / score / save split. Read-only; saves to a scratch copy of the cache table.
- `after_real_db.py` → `after_real_db_results.txt`: the same six families through the real endpoint after vectorising, cold and warm.
- `real_compare.py`: vectorised scorer vs `score_pair` on every candidate of five real families (0 mismatches over 37,787).
- `sparse_ref.py`: the audit prototype crashes for a reference with fewer than 30 shared points; `score_pair` does not.
- `why_neff.py`, `why_charge.py`: false-positive rates of unrelated smooth series with and without effective N and the m_eff lag charge (used to explain the method, not to change it).
- `x2_equivalence.py`: old vs new date-filtered top query, 48 combinations, identical rows.
- `x4_snapshot.py`: saves 15 `/search/annotations` responses, then compares after the change (identical).

**Live server** (`metatrace.uw.edu`, 1.9 GB RAM, SQLite 3.46.1); copied into `~/HAB/FastAPI/`, run with the app's venv, then removed. All read-only. Outputs in `server_results.txt`.

- `time_family_pieces.py`: one cold correlation family split into sample order / candidates / read / score.
- `time_date_range_top.py`: date-filtered top, today's query vs `(source, sample)` row values (rejected).
- `time_date_range_top2.py`: today's query vs covering index + catalog join (chosen).
- `check_sample_names.py`: SQLite version, skip-ahead, time to list the 128 samples.
- `check_x4.py`: catalog top fetch and search with/without the per-row lookups.

A lesson from these runs: two queries reading the same table rows cannot be
timed one after the other on the same date range, because the second finds the
rows already in memory. The date-range scripts give each query its own
untouched range first, then swap.
