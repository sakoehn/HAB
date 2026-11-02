# HAB Portal

A time-series explorer for metagenomic annotation data from Harmful Algal Bloom (HAB) research at Rosario, Orcas Island — 128 samples sequenced by JGI, spanning ~3 weeks in May-June 2021.

The portal lets researchers browse, chart, and statistically correlate four kinds of gene annotation across that whole time series: **KEGG Orthology** (functional), **COG** (functional), **Enzyme Commission** (biochemical), and **Taxonomy** (organism, domain down to strain).

## Features

- **Analyze** — search for an annotation, chart its abundance (raw or normalized) across all 128 samples, overlay day/night and tide data, find statistically significant correlates against any of the four annotation types.
- **Compare** — overlay multiple annotations or groups on one chart.
- **Explore** — browse top annotations by abundance, drill into scaffold-level detail.
- **Taxonomy** — browse and filter the full taxonomic tree, export by rank.
- **Correlation finder** — for any annotation, finds other annotations whose abundance co-varies with it (Spearman, log-Pearson, or raw Pearson; on raw EGC or normalized relative abundance). P-values account for autocorrelation through an effective sample size (Pyper & Peterman 1998) and are corrected for both the multi-lag search (Bonferroni) and the multiple-candidate family (Benjamini-Hochberg FDR); every candidate is listed by |r| with the significant ones marked. Same-source results exclude siblings/ancestors/descendants automatically to avoid compositional and containment artifacts.

### How values are calculated

- **EGC (Estimated Gene Copies)** — `Σ scaffold(gene_count × coverage)` across every scaffold contributing genes to an annotation, per sample.
- **norm_egc (relative abundance)** — EGC divided by the same gene-weighted depth sum, but summed across *every* annotated scaffold in the sample (not just this annotation's) — bounds it to `[0, 1]`, the fraction of all annotated signal this annotation accounts for. The denominator is shared across all four annotation types, so norm_egc is comparable cross-source.

See the in-app **About & API** page for the full annotation-type reference and API endpoint list.

## Tech stack

- **Backend:** FastAPI (Python), SQLite
- **Frontend:** React + TypeScript, Vite, Plotly

## Project structure

```
FastAPI/
  main.py           -- app entry point, router registration, CORS, lifespan/startup
  api/
    routes.py        -- most endpoints (search, series, taxonomy, mappings, scaffolds...)
    correlation_sql.py -- correlation finder: pairwise cache (Tier 1) + family/FDR (Tier 2)
    correlation_loaders.py -- sample order and per-annotation vectors for the correlation finder
    cache_sql.py     -- SQLite query layer used by the routes
    ec_renumbering.py -- maps renumbered/partial EC labels onto the enzyme tree (shared with the notebooks)
    cache.py, astronomy.py -- tide data and sunrise/sunset times
    index.py, config.py, db.py -- date helpers, paths/constants, database connection
  scripts/           -- one-off migration/schema scripts (populate the SQLite db from raw JGI files)
frontend/
  src/
    pages/           -- Analyze, Compare, Explore, Taxonomy, About
    components/      -- charts, panels (mappings, correlates, scaffolds), shared UI
    types.ts, constants.ts, utils/
tests/               -- pytest backend tests (test_correlation_*.py, etc.)
```

`DataStructures/`, raw JGI data directories, and the SQLite database file are gitignored — see **Database** below.

## Getting started

### Prerequisites

- Python 3.11+
- Node 18+

### Backend

```bash
pip install -r requirements.txt
```

Run from `FastAPI/`:

```bash
uvicorn main:app --reload
```

Serves on `http://localhost:8000`. `GET /status` reports readiness.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Serves on `http://localhost:5173`, proxying `/api/*` to the backend on `:8000` (see `vite.config.ts`).

### Database

The app needs `hab_mappings.db` (a SQLite file, gitignored — too large for git) at the repo root. It's built from the raw per-sample JGI annotation JSON files via the scripts in `FastAPI/scripts/` — schema creation, bulk mapping/annotation ingestion, index building, and catalog aggregation, roughly in that order (`create_sql_schema.py` → `migrate_mappings_to_sql.py` → `create_sql_indexes.py` → `migrate_annotations_to_sql.py` → `migrate_annotation_catalog_sql.py`). Each script's own docstring documents its exact inputs/outputs and re-run safety. **Ask a project maintainer for a copy of the database rather than rebuilding it from scratch** unless you're specifically working on the migration pipeline — it's a multi-hour process over tens of millions of rows.

## Testing

Backend:

```bash
pytest
```

Frontend:

```bash
cd frontend
npm test              # unit + component tests (vitest)
```

`playwright.config.ts` and a `test:e2e` script are set up for end-to-end tests, but no spec file currently exists at the path it points to (`src/App.e2e.spec.ts`) — add one there to use it.

## Known limitations

- `/mappings/search` scans a 74M-row table and can be slow (30s+) on modest hardware since it isn't fully indexable.
- The correlation finder's taxonomy candidates are capped at genus-and-coarser ranks (species/strain excluded) — otherwise a single query would need to score against ~60,000 taxa.
- A correlation query against a brand-new (never-yet-cached) annotation/source/method/metric combination can take several minutes the first time; every subsequent query for that same combination is fast, since results are cached permanently.
