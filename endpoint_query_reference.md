# API Query Reference

Notes for deciding on a DB (Mongo vs. other options). Two tables:
1. Queries the app actually makes today.
2. Queries a researcher might want that aren't implemented — useful for
   stress-testing what a DB needs to support.

---

## 1. Queries currently in use (frontend -> FastAPI)

| Endpoint | Returns | What the app does with it |
|---|---|---|
| `/timepoints?page_size=1` | 1 sample row | Ping only — sets online/offline flag (App.tsx) |
| `/status` | index_ready, date_min/max | Polled every 2s at startup; gates UI until index ready, sets global date-picker bounds |
| `/sun-times` | sunrise/sunset per date | Shading overlay on time-series charts (fetched once, cached) |
| `/tides` | tide height every 6 min | Tide-height overlay on time-series charts (fetched once, cached) |
| `/taxonomy/children?parent=X` | direct child taxa | Lazily expands nodes in the taxonomy browse tree |
| `/search/annotations?q=&sources=` | matching annotation IDs+names, ranked | Powers autocomplete/search boxes (Taxonomy, Analyze, Explore, Compare, Scaffold panels) |
| `/series/annotations?source=&annotation_id=` | EGC + norm_egc per sample, chronological | Plotted as the time-series line chart (Taxonomy, Analyze, Explore, Compare pages) |
| `/annotations/top?source=&limit=` | top-N annotations by mean EGC | Ranked leaderboard list used to seed exploration (Explore, Scaffold panel) |
| `/annotations/scaffolds/summary?source=&annotation_id=` | per-sample scaffold_count/gene_count | Summary table in scaffold modals |
| `/annotations/scaffolds?source=&annotation_id=` | per-scaffold gene counts, all samples | Detail row list in scaffold modals |
| `/mappings/search?annotation_id=&source=` | matching mapping rows across samples | Searchable/paginated mappings table panel |
| `/annotations/correlate?source=&annotation_id=` | Spearman-correlated candidate annotations | Correlates panel — ranked list of correlated annotations |

**Defined but not called anywhere in the frontend** (only referenced as doc text
in AboutPage; kept for now, see notes below):
`/debug`, `/mongo-test`, `/samples`, `/samples/{name}/mappings`,
`/samples/{name}/mappings/summary`, `/samples/{name}/cog`,
`/samples/{name}/kegg`, `/samples/{name}/enzyme`, `/samples/{name}/taxonomy`,
`/samples/{name}/full`, `/samples/{name}/search/annotations`.

- `/debug` and `/mongo-test` are truly dead (no meaningful test coverage).
- The rest are unused by the UI but are the ground-truth contract that
  `tests/test_egc_api_vs_jgi.py` and `tests/test_unit_backend.py` hit directly
  to cross-validate EGC values against the raw JGI source files
  (see `tests/README.md`). Deleting them would lose that regression coverage.

---

## 2. Hypothetical queriesa for future (not implemented)

| Endpoint | Would return | Researcher use |
|---|---|---|
| `/samples/{id}/mappings?gene_id=` | the single flat mapping row (taxonomy+kegg+enzyme+cog) for one gene | Cross-reference a gene's annotations in one call — data's already flat (one row per gene), just needs the filter param + a gene_id index (`_MAPPING_INDEX` is currently keyed by annotation_id, not gene_id) |
| `/annotations/{id}/co-occurring` | other annotation IDs that share gene rows with this one, aggregated across samples | Functional co-occurrence — doable by scanning existing mapping rows, no new schema, just no aggregation endpoint yet |
| `/annotations/{id}/co-annotations?target_source=` | which taxa carry a given COG/enzyme term (or vice versa) | Same idea, cross-source direction — same underlying flat row, still missing |
| `/samples/diff?from=&to=` | annotations that appeared/disappeared/changed sign between two timepoints | Delta queries, e.g. "what changed between low and high tide" |
| `/annotations/matrix?source=&ids=[]` | samples x annotations EGC matrix for a chosen ID list | Bulk export — matrix already exists in-memory as `_EGC_MATRIX`, just not exposed |
| `/taxonomy/path/{taxon_id}` | ancestor chain root->leaf | Lineage breadcrumb — trivial walk over the already-loaded parent map, missing endpoint only |
| `/kegg/pathway/{pathway_id}/levels` | KEGG A/B/C/D hierarchy for one pathway | Same as above, second hierarchy, same parent map mechanism |
| `/taxonomy/diversity?date_range=` | Shannon/Simpson diversity per sample | Needs picking one taxonomic rank's leaves and computing real proportions — genuinely new stats, not in the app |
| `/annotations/search?fuzzy=true` | typo-tolerant / stemmed matches on annotation_id or name | Real gap — current index is exact-token-only (splits on whitespace, no fuzzy/stemming) |
| `/annotations/{id}/periodicity` | tidal/diel cycle strength in EGC over time | Rhythm analysis — genuinely new, nothing like it exists |
| `/environment/correlate?variable=tide\|sun&source=&annotation_id=` | correlation of EGC against tide height / daylight | Genuine gap — `correlation.py` only ever correlates annotation vs. annotation |
| `/annotations/covariance-matrix?source=&ids=[]` | full pairwise correlation matrix for a chosen ID list | Exposes existing `_EGC_MATRIX`/`_NORM_EGC_MATRIX` as a bulk matrix instead of one-vs-many |
| `/annotations/clusters?source=` | groups of annotations with similar EGC trajectories | Genuinely new — no clustering exists anywhere |
| `/samples/{id}/neighbors?k=` | nearest samples by taxonomic-composition distance | New computation, but derivable by transposing the existing EGC matrix — not a new data source |
| `/samples/compare?ids=[]&metric=` | pairwise sample distance matrix | Same family as above |
| `/samples/{id}/scaffolds/{scaffold_id}/annotations` | every annotation on one scaffold, within that sample | Reverse lookup from assembly location — scaffold IDs are sample-scoped |
| `/annotations/outliers?source=&threshold=` | annotations exceeding N std-devs in one or more samples | Anomaly detection — nothing like it exists, only top-by-mean |
| `/samples/gaps` | missing/expected-but-absent timepoints | Already manually tracked in `known_data_gaps.md`; genuinely missing as a live queryable endpoint |
| `/metadata/samples/{id}` | physical/chemical metadata (temp, salinity, pH...) | Genuine gap — `JGI_ID_Timepoints_128.csv` only has `taxon_oid, Timepoint, DateTime, R_taxon_ids`, nothing environmental beyond tide/sun |
| `/provenance/pipeline-runs` | JGI pipeline version/params behind the dataset | Genuine gap — no version metadata tracked anywhere |
| `/export/sample/{id}?format=biom\|csv` | full sample export in a standard bioinformatics format | Format-conversion service, not a query |
| `/search/global?q=` | matches across genes, scaffolds, taxa, samples together | Genuine gap — the inverted index is per-annotation-source only |
| `/annotations/{id}/notes` | researcher-authored notes/tags | Only row needing durable, user-scoped writes — everything else is read-only derived data |

### DB-decision takeaway

- The mapping TSVs are already a flat, gene-level denormalized table (good
  relational/columnar fit).
- The taxonomy/KEGG parent chains are already a simple adjacency-list tree
  (fine in either doc or relational form, doesn't need a graph DB).
- The rows that genuinely require something the current file-cache
  architecture can't already do cheaply: environmental metadata (new schema),
  pipeline provenance (new schema), fuzzy text search (needs a text-index-
  capable store), and user notes (needs real write/consistency guarantees).
