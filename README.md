# Metatrace

A time-series explorer for metagenomic annotation data from a Harmful Algal Bloom (HAB) at Rosario, Orcas Island, Washington: 128 samples collected roughly every 4 hours from 27 May to 18 June 2021, sequenced and annotated by the DOE Joint Genome Institute (JGI).

Live at **https://metatrace.uw.edu**.

The portal lets researchers browse, chart, download and statistically correlate four kinds of gene annotation across the whole time series: **KEGG Orthology** (functional), **COG** (functional), **Enzyme Commission** (biochemical), and **Taxonomy** (organism, domain down to strain).

## Features

- **Analyze** — search for annotations, chart their abundance across all 128 samples (one card per annotation, or several summed into a group), overlay day/night shading and tide height, and open per-annotation panels: gene-to-scaffold mappings, scaffold detail, the KEGG/COG/EC hierarchy an annotation sits in, and the correlation finder.
- **Compare** — overlay up to 4 annotations on one chart, optionally Z-scored so series of very different sizes can be compared by shape.
- **Explore** — six views: Dataset Overview, Top EGC Annotations, Annotations by Parent, Annotation Lookup, Scaffold Information, and Bulk Download (CSV time series for every term at a chosen level of the KEGG, COG, EC or taxonomy hierarchy).
- **Taxonomy** — pick a scope taxon, then remove branches from its total or keep only the branches you choose, to see how much each contributes over time.
- **Correlation finder** — for any annotation, scores every candidate in a chosen source for how closely its abundance moves with the reference (Spearman, log-Pearson, or raw Pearson; on raw EGC or relative abundance), at time lags of up to ±24 h. P-values account for autocorrelation through an effective sample size (Pyper & Peterman 1998) and are corrected for both the lag search (Bonferroni, by the number of separate tests the lags are worth for that pair; Li & Ji 2005) and the number of candidates (Benjamini-Hochberg FDR). Trends shared across the bloom count as a real relationship. Every candidate is listed, significant ones first and then the rest by |r|. Same-source results exclude siblings/ancestors/descendants automatically to avoid compositional and containment artifacts; for KEGG, only a real pathway makes two KOs siblings (not a Brite protein-family table such as Transporters).
- **Methods** and **About & API** — how every value is calculated, data sources, and the HTTP API reference.

### How values are calculated

- **EGC (Estimated Gene Copies)** — `Σ over scaffolds (genes on the scaffold with this annotation × scaffold average read depth)`, per sample.
- **norm_egc (relative abundance)** — EGC divided by the same gene-weighted depth summed over *every* annotated scaffold in the sample, so it lies in `[0, 1]`: the share of all annotated signal this annotation accounts for. The denominator is shared across all four annotation types, so norm_egc is comparable across sources.
- **Correlation significance** — samples taken 4 hours apart are not independent, so the 128 samples are worth about 30 independent observations; only strong correlations can be confirmed as significant.

The in-app **Methods** page is the full reference (hierarchy roll-up, renumbered EC numbers, Z-score, LOWESS, descriptive statistics, and the correlation method in detail).

## Tech stack

- **Backend:** FastAPI (Python), SQLite
- **Frontend:** React + TypeScript, Vite, Plotly

## Project structure

```
FastAPI/
  main.py           -- app entry point, router registration, security headers, startup
  api/
    routes.py        -- most endpoints (search, series, export, taxonomy, mappings, scaffolds, hierarchy...)
    cache_sql.py     -- SQLite query layer used by the routes
    correlation_sql.py -- correlation finder: pairwise cache (Tier 1) + family/FDR (Tier 2)
    correlation_loaders.py -- sample order and per-annotation vectors for the correlation finder
    ec_renumbering.py -- maps renumbered/partial EC labels onto the enzyme tree (shared with the notebooks)
    taxon_lineage.py -- normalises taxonomy lineage strings
    cache.py, astronomy.py -- tide data and sunrise/sunset times
    index.py, config.py, db.py -- date helpers, paths/constants, database connection
  scripts/           -- schema, migration and one-off maintenance scripts (build the SQLite db from raw JGI files)
frontend/
  src/
    pages/           -- Analyze, Compare, Explore, Taxonomy, Methods, About
    components/      -- charts, panels (mappings, correlates, scaffolds, hierarchy), shared UI
    tests/           -- vitest unit/component tests, plus a Playwright end-to-end spec
    types.ts, constants.ts, utils/
tests/               -- pytest backend tests (tests/sql/ for the database layer)
```

`DataStructures/`, `Metagenome_Samples/`, and the SQLite database file are gitignored — see **Database** below.

## Getting started

### Prerequisites

- Python 3.11+
- Node 20.19+ or 22.12+ (required by Vite 8; CI uses Node 24)

### Backend

```bash
pip install -r requirements.txt
```

Run from `FastAPI/`:

```bash
uvicorn main:app --reload
```

Serves on `http://localhost:8000`. `GET /api/status` reports readiness.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Serves on `http://localhost:5173`, proxying `/api/*` to the backend on `:8000` (see `vite.config.ts`).

### Database

The app needs `hab_mappings.db` (a ~64 GB SQLite file, gitignored) at the repo root. It is built by the scripts in `FastAPI/scripts/` from the per-sample annotation JSONs in `DataStructures/`, the raw JGI files in `Metagenome_Samples/`, and the KEGG BRITE hierarchy files: `create_sql_schema.py` first, then the `migrate_*_to_sql.py` scripts (mappings, annotations, annotation catalog, and the KEGG/COG/EC path tables) and `create_sql_indexes.py`. Each script's docstring documents its exact inputs, outputs, ordering and re-run safety. **Ask a project maintainer for a copy of the database rather than rebuilding it** unless you are working on the migration pipeline — it is a multi-hour process over tens of millions of rows.

## Testing

Backend (some tests need `hab_mappings.db` or the raw JGI files; see `.github/workflows/ci.yml` for the self-contained set):

```bash
pytest
```

Frontend:

```bash
cd frontend
npm test                          # unit + component tests (vitest)
npx tsc --noEmit -p tsconfig.app.json   # type check (plain `tsc -p .` checks nothing here)
npm run lint
npx playwright test               # end-to-end specs (src/**/*.e2e.spec.ts); starts both servers, needs the database
```

CI (`.github/workflows/ci.yml`) runs the self-contained backend tests, frontend lint (no warnings allowed), the vitest suite, and the production build.

## Known limitations

- `/mappings/search` scans a 74M-row table and can be slow (30s+) on modest hardware.
- The correlation finder's taxonomy candidates are capped at genus-and-coarser ranks (species/strain excluded) — otherwise a single query would need to score against ~60,000 taxa.
- The first correlation search for a given annotation/source/method/metric combination scores every candidate and can take a minute or more (longer for large families); results are cached, so repeating it is fast. The panel retries on its own while the server works.
