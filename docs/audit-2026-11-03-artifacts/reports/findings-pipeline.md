# Pipeline audit — data production upstream of SQLite (HEAD a993ead)

(Transcribed by the coordinator from the pipeline reviewer's hand-back; the reviewer could not write this file itself.)

Scope: Notebooks/*.ipynb and *.py, FastAPI/scripts/*.py, api/ec_renumbering.py, api/taxon_lineage.py, related tests.
Method: read every code cell/script; ran the notebooks' BRITE parsers, the path-table builders and the KEGG roll-up (cell 7 logic) against today's live ko00001.keg / ko01000.keg (scratchpad/kegg_dl/); checked every TRANSFERRED_EC entry and all of 3.6.3.1–55 against KEGG ENZYME via REST; ran `pytest tests/ -m "not api"` (410 pass; the only failures are the three data-dependent files CI already ignores).

Scripts: brite_experiment.py/.out, kegg_sibling_experiment.py/.out, notebook code-cell dumps *.txt.

---

### [M] KEGG BRITE protein-family tables and "Not Included" groups are stored as depth-3 "pathways", and they drive the correlation finder's sibling exclusion

Where: Notebooks/EGC_KEGG_TREE.ipynb cell 5 (parses all A-sections of ko00001.keg, including A09180 Brite Hierarchies and A09190 Not Included in Pathway or Brite) and cell 7 line 75 (walks every occurrence); FastAPI/scripts/migrate_kegg_paths_to_sql.py:97-130 (one kegg_paths row per occurrence, no section tag); FastAPI/api/routes.py:974 ("pathway": 3); FastAPI/api/correlation_sql.py:274-281 (siblings = every KO sharing any immediate parent).

What: 81 of the 571 depth-3 KEGG nodes are not pathways: 56 BRITE tables (02000 Transporters [BR:ko02000] 2,260 KOs, 03000 Transcription factors 1,519, 04131 Membrane trafficking 1,468, 03036 Chromosome and associated proteins 1,241, 01002 Peptidases and inhibitors 1,064, …), 24 "Not Included" groups (99980 Enzymes with EC numbers 1,589 KOs, 99996/99997, …), and 09113 Global maps only. Nothing in annotation_series/kegg_paths distinguishes a BRITE table from a pathway map.

Effect:
1. Correlation finder, same-source KEGG: K02014 (TonB-dependent receptor) has exactly one immediate parent, 02000 Transporters, so all 2,260 transporter KOs are silently excluded as "siblings" (1 would be excluded from pathway parents alone). K03924 (moxR): 1,589 excluded via 99980 (vs 1). K00844 hexokinase: 2,248 excluded vs 864 from its 13 real pathways.
2. Explore → Top EGC / Annotations by Parent / Bulk Download at level "pathway" list Transporters [BR:ko02000], Enzymes with EC numbers, Transcription factors [BR:ko03000] as pathways; with 1,000–2,300 members each they sit at the top of any pathway ranking.

Verified: code read; counts computed on today's ko00001.keg with the migration script's own iter_kegg_path_rows and a line-for-line replica of _kegg_family_exclusions (kegg_sibling_experiment.py). Deployed May-2026 copy may differ by a few KOs.

Fix: a_id is already in kegg_paths — restrict the sibling set in _kegg_family_exclusions to parents whose a_id is one of the six pathway classes (09100–09160), or c_name LIKE '%[PATH:%'; keep BRITE/"Not included" occurrences for ancestor/descendant exclusion and the hierarchy popup. Label depth-3 nodes without [PATH: as "BRITE table"/"group" in Explore/Bulk Download and say so on the Methods page.

### [L] Stored single parent/category of KO leaves is the last BRITE occurrence (quantified)

EGC_KEGG_TREE.ipynb cell 5 line 27 (brite[node_id] overwritten per occurrence; cell 7 copies parent_id/category); migrate_annotations_to_sql.py:89-90. On today's file 18,626 of 28,571 KOs get category "Brite Hierarchies" and 3,803 "Not Included"; 8,725 KOs that are in a real pathway are stored under a BRITE table (K00844 → 04131 Membrane trafficking). W30 fixed the UI via /kegg/parents; the fallback path (ExplorePage.tsx:731, AnnotationInfoDrawer.tsx:101) and raw API fields still expose it. Fix: prefer the first pathway-class occurrence, or drop the column for KEGG.

### [L] Silent skips and unchecked inputs in the raw readers and migrations

- Build_KEGG_DB.ipynb cell 3: `if len(info) < 3: continue` drops malformed .a.ko.txt rows silently; mappings.ipynb would IndexError instead, so the two gene universes can diverge.
- All_Coverages.py:21,25: lines not starting with 'G' or with <2 columns skipped; such a scaffold gets coverage 0 in numerators and KeyError in the denominator.
- mappings.ipynb cell 2: a missing raw file returns {} with no message.
- migrate_annotations_to_sql.py:111-115: loads every *.<suffix> file; no check that the set equals the 128 samples.
- migrate_mappings_to_sql.py:237: taxon_lookup.get(...) → NULL taxon_path_id with no count/log.
- verify_annotations_migration_against_json.py:99-104 compares only egc/norm_egc; gene_count, scaffold_count, depth, parent, name never checked.

### [L] Numerator tolerates a missing depth row silently while the denominator raises

EGC_*_TREE notebooks `cov = covs.get(scaff, 0)` vs weighted_totals.py:128 `allfold[s][scaff]` (KeyError). A gene whose scaffold has no depth row contributes 0 to EGC but still counts in gene_count/scaffold_count. Today the denominator's KeyError aborts first.

### [L] ko00001.keg has no provenance record

download_enzyme_brite.py writes a .meta.json for ko01000.keg; nothing equivalent for ko00001.keg. KEGG_preDatabase.ipynb still carries the superseded single-parent parse_brite.

---

## Checked and found correct

- EGC = Σ_scaffold (distinct genes with the annotation on that scaffold × AvgFold) per sample in all four notebooks; scaffold from gene_id.rsplit('_', 2)[0]; genes deduplicated per (node, sample). Dropped: 33 KOs / 19 COGs absent from references, 0 ECs (MISSING_ANNOTATIONS.md).
- norm_egc: weighted_totals.calculate_denominator_egc = Σ over all TSV genes (union of the four sources, each gene once) of count×AvgFold; every numerator is a subset with identical coverage lookups, so norm_egc ∈ [0,1].
- Roll-up: gene with K00844+K12407 (both in 00010) counts once in 00010/09101/09100; K00844 reached under all 14 parents; COG leaf once, every real category once; EC walk up parent chain once per node. gene_count = Σ scaffold counts, scaffold_count = len(scaffolds), same dict as EGC.
- EC: all 19 TRANSFERRED_EC entries and 3.6.3.- → 7 match KEGG ENZYME today; resolve_or_drop_ec order matches the Methods text; ko01000.keg parse 7,334 nodes, 0 regex failures.
- Taxonomy: keyed by lineage prefix; normalize_lineage shared; depth = position; parent = prefix; each gene once per rank; identical consecutive names kept as distinct ranks.
- Catalog: AVG/MAX over annotation_series rows (detected samples only); sample_count = detected count.
- Migration: plain INSERT under UNIQUE; taxon_paths INSERT OR IGNORE merges identical lineages only; delete-then-insert scoped per (source, sample); KEGG ids stay strings.
- Paths: kegg_paths row count equals the notebook's occurrence count per KO; no id at two depths; enzyme_paths one row per node; cog_paths keeps 400 multi-category COGs.

## Could not verify without the database / raw data

- .a.depth.txt column layout; conftest.py claims 0 EGC mismatches vs JGI across 128 samples.
- Whether any gene has >1 KO row in .a.ko.txt (schema docstring says at most one; Build_KEGG_DB's docstring says the opposite). If so, mappings.kegg_id would hold "KO:K1,KO:K2" and cache_sql's exact IN match would miss it in the mappings panel.
- JGI_ID_Timepoints_128.csv taxon_oid formatting vs sample_names.txt.
- Deployed ko00001.keg (May 2026) vs today's file.
- Lineage strings with whitespace around ';' or a leading '"'.
