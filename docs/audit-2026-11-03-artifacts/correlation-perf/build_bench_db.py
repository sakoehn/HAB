"""
Build a realistic synthetic hab_mappings-style SQLite db for benchmarking
the correlation finder. Uses the REAL schema + indexes from
FastAPI/scripts/create_sql_schema.py / create_sql_indexes.py.

Sources and candidate counts (approximate real sizes):
  kegg     13,000 annotations
  cog       5,000
  enzyme    4,000
  taxonomy  6,000 at depth <= 6 plus 4,000 at depth 7-8 (excluded by cutoff)
128 samples named s000..s127 (zero-padded so plain string order == time order;
no timepoints CSV exists locally so timepoint_sort_key returns -1.0 for all
and sorted() keeps the DISTINCT order, which is index order = string order).

Series: AR(1) in log space (phi ~ U(0.6, 0.95)), log-normal values; a
detection threshold removes the lowest values plus random dropout so that a
typical candidate has 15-25% missing, 10% of candidates are sparse (55-95%
missing), and ~2% of present rows carry egc = 0.0 (treated as missing by
_transformed_pair). Rows are inserted per sample (as the real migration does),
so one annotation's 128 rows are scattered across the table.
"""
import os, sys, sqlite3, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = "/home/mriffle/dev/sophie-metatrace/HAB"
sys.path.insert(0, os.path.join(REPO, "FastAPI"))
from scripts.create_sql_schema import SCHEMA   # noqa
from scripts.create_sql_indexes import INDEXES  # noqa

DB_PATH = os.path.join(HERE, "bench.db")
N_SAMPLES = 128
SAMPLES = [f"s{i:03d}" for i in range(N_SAMPLES)]
SOURCES = {
    "kegg": 13_000,
    "cog": 5_000,
    "enzyme": 4_000,
    "taxonomy": 10_000,
}
rng = np.random.default_rng(20261103)


def make_series(n_ann: int):
    """Return (values[n_ann, 128] float with NaN for absent, zero_rows mask)."""
    phi = rng.uniform(0.6, 0.95, size=(n_ann, 1))
    mu = rng.normal(5.0, 2.0, size=(n_ann, 1))
    sigma = rng.uniform(0.3, 1.2, size=(n_ann, 1))
    eps = rng.normal(size=(n_ann, N_SAMPLES))
    z = np.empty((n_ann, N_SAMPLES))
    z[:, 0] = eps[:, 0] / np.sqrt(1 - phi[:, 0] ** 2)
    for t in range(1, N_SAMPLES):
        z[:, t] = phi[:, 0] * z[:, t - 1] + eps[:, t]
    logv = mu + sigma * z
    # some candidates share a bloom-wide trend with everything else
    trend = np.sin(np.linspace(0, 3 * np.pi, N_SAMPLES))[None, :]
    share = rng.uniform(0, 1.0, size=(n_ann, 1)) * (rng.random((n_ann, 1)) < 0.3)
    logv = logv + share * trend
    v = np.exp(logv)
    # missingness: target fraction per candidate
    frac = rng.uniform(0.15, 0.25, size=n_ann)
    sparse = rng.random(n_ann) < 0.10
    frac[sparse] = rng.uniform(0.55, 0.95, size=sparse.sum())
    # detection threshold: remove the lowest ~frac/2 values, random dropout the rest
    idx = np.floor(frac / 2 * (N_SAMPLES - 1)).astype(int)
    q = np.take_along_axis(np.sort(v, axis=1), idx[:, None], axis=1)[:, 0]
    present = v > q[:, None]
    drop = rng.random((n_ann, N_SAMPLES)) < (frac / 2)[:, None]
    present &= ~drop
    v = np.where(present, v, np.nan)
    zero_rows = present & (rng.random((n_ann, N_SAMPLES)) < 0.02)
    v[zero_rows] = 0.0
    return v


def build():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    for ext in ("-wal", "-shm"):
        if os.path.exists(DB_PATH + ext):
            os.remove(DB_PATH + ext)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    conn.commit()
    t0 = time.time()
    catalog_rows = []
    cat_id = 0
    series_by_source = {}
    for source, n in SOURCES.items():
        vals = make_series(n)
        ann_ids = []
        depths = []
        for i in range(n):
            if source == "kegg":
                aid = f"K{i:05d}"; depth = 4
            elif source == "cog":
                aid = f"COG{i:04d}"; depth = 2
            elif source == "enzyme":
                aid = f"{1 + i % 6}.{(i // 6) % 20 + 1}.{(i // 120) % 30 + 1}.{i // 3600 + 1}"; depth = 4
            else:
                depth = 1 + (i % 8)  # 1..8; depth<=6 are candidates
                aid = ";".join(f"t{i}_{d}" for d in range(depth))
            ann_ids.append(aid); depths.append(depth)
        series_by_source[source] = (vals, ann_ids)
        for i, aid in enumerate(ann_ids):
            cat_id += 1
            row = vals[i]
            present = np.isfinite(row)
            catalog_rows.append((cat_id, source, aid, f"name of {aid}", None,
                                 float(np.nanmean(row)) if present.any() else None,
                                 float(np.nanmax(row)) if present.any() else None,
                                 None, None, int(present.sum()), depths[i]))
    conn.executemany(
        "INSERT INTO annotation_catalog (id, source, annotation_id, name, parent, mean_egc, max_egc, "
        "mean_norm_egc, max_norm_egc, sample_count, depth) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        catalog_rows,
    )
    conn.commit()
    # per-sample insertion order, like migrate_annotations_to_sql.py
    sample_totals = np.exp(rng.normal(14, 0.3, size=N_SAMPLES))
    n_rows = 0
    for s_idx, sample in enumerate(SAMPLES):
        rows = []
        for source, (vals, ann_ids) in series_by_source.items():
            col = vals[:, s_idx]
            present = np.isfinite(col)
            for i in np.nonzero(present)[0]:
                egc = float(col[i])
                rows.append((source, sample, ann_ids[i], f"name of {ann_ids[i]}", None, None,
                             None, egc, egc / sample_totals[s_idx], 3, 7))
        conn.executemany(
            "INSERT INTO annotation_series (source, sample, annotation_id, name, category, parent, depth, "
            "egc, norm_egc, scaffold_count, gene_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
        conn.commit()
        n_rows += len(rows)
    # cog_paths: category membership so same-source cog families work
    conn.executemany("INSERT INTO cog_paths (a_id, b_id, full_path) VALUES (?,?,?)",
                     [(chr(65 + i % 20), f"COG{i:04d}", f"{chr(65 + i % 20)}|COG{i:04d}") for i in range(SOURCES['cog'])])
    # kegg_paths: pathway membership (random single parent)
    conn.executemany("INSERT INTO kegg_paths (a_id, b_id, c_id, d_id, full_path) VALUES (?,?,?,?,?)",
                     [(f"091{i%4:02d}", f"0911{i%20:02d}", f"00{i%200:03d}", f"K{i:05d}", f"091{i%4:02d}|0911{i%20:02d}|00{i%200:03d}|K{i:05d}") for i in range(SOURCES['kegg'])])
    conn.commit()
    print(f"inserted {n_rows:,} annotation_series rows, {len(catalog_rows):,} catalog rows in {time.time()-t0:.1f}s")
    t1 = time.time()
    conn.executescript(INDEXES)
    conn.commit()
    print(f"indexes built in {time.time()-t1:.1f}s")
    conn.execute("ANALYZE")
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    print("db size MB:", os.path.getsize(DB_PATH) / 1e6)


if __name__ == "__main__":
    build()
