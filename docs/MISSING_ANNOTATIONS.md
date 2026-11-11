# Missing Annotations

Three of the four EGC notebooks (`EGC_COG_TREE.ipynb`,
`EGC_KEGG_TREE.ipynb`, `EGC_ENZYME_TREE.ipynb`) skip
any real annotation id that isn't found in an externally-sourced reference
(NCBI's scraped COG category tables, KEGG's `ko00001.keg` BRITE hierarchy,
KEGG's `ko01000.keg` EC hierarchy). That's the right behavior — a gene can't
be rolled up into a tree node that doesn't exist — but on its own, nothing
would record *what* got dropped or *how much*, so a genuinely truncated
download would look identical to a small number of expected gaps.

This doc is the real answer, computed directly from the current dataset (not
estimated): every id that appears in the raw per-gene annotation files
(`.a.cog.txt` / `.a.ko.txt` / `.a.ec.txt`, all 128 samples) but is absent
from the corresponding regenerated `DataStructures/<Source>/*.json` output.

| Source | Real distinct ids | Matched | Dropped | % dropped |
|---|---:|---:|---:|---:|
| COG    | 4,631  | 4,612  | 19  | 0.4% |
| KEGG   | 12,286 | 12,253 | 33  | 0.3% |
| Enzyme | 3,395  | 3,240  | 155 | 4.6% |

All three are small relative to their real annotation universe. Enzyme's
number looks higher, but see below — most of it isn't the same kind of gap.

## COG — 19 ids not in NCBI's scraped category tables

No obvious pattern (not a version range, not one category) — most likely a
mix of ids that are genuinely obsolete/merged in NCBI's live COG database, or
ids NCBI's category-listing pages don't happen to surface via the scrape
(the scrape reads 26 category listing pages, not a single canonical id list).

```
COG5022  COG5032  COG5038  COG5044  COG5049  COG5074  COG5096  COG5183
COG5239  COG5244  COG5260  COG5354  COG5384  COG5406  COG5414  COG5602
COG5624  COG5627  COG5644
```

## KEGG — 33 ids not in `ko00001.keg`

Also no obvious pattern. `ko00001.keg` is KEGG's full BRITE hierarchy file
(28,893 nodes) — a real KO id missing from it most likely means that KO has
been retired/merged into another one since the file was last downloaded.

```
K00050  K01144  K01263  K01594  K02428  K03050  K03155  K03815  K04551
K04844  K07015  K07239  K08511  K09394  K09469  K10904  K11681  K12539
K15032  K15339  K16120  K16291  K16299  K16300  K17871  K18707  K19234
K19235  K21394  K22020  K24301  K24302  K24305
```

## Enzyme — 155 ids not in `ko01000.keg`, mostly a different phenomenon

Checked the shape of this list before assuming it means the same thing as
COG/KEGG's gaps above: **135 of the 155 (87%) are partial/wildcard EC
classifications** — annotation calls like `1.1.1.-`, ending in a dash, that
mean "some enzyme in this EC subclass, exact one unresolved." KEGG's
`ko01000.keg` only lists fully-resolved, complete EC numbers (real leaf
nodes), so a partial call was never going to match it — this isn't a
reference-file gap, it's an expected consequence of the annotation pipeline
sometimes only resolving a gene to a subclass, not a specific enzyme.

**The other 20 are fully-resolved, 4-level EC numbers that are genuinely
missing** from the local `ko01000.keg` — the real analog to COG/KEGG's gaps
above:

```
1.2.99.7  1.3.5.4   1.4.3.24  1.6.1.2   1.8.99.5  2.1.1.86  2.3.1.182
2.4.1.129 2.4.99.4  2.7.7.58  3.1.22.4  3.1.3.81  3.13.1.8  3.3.1.1
3.6.4.10  3.6.4.12  3.6.4.13  4.3.3.2   4.99.1.1  7.2.4.8
```

The full 135 partial/wildcard ids (not reproduced individually here, since
they're an expected category rather than individual gaps worth reviewing
one by one):

```
1.-       1.1.-     1.1.1.-   1.1.2.-   1.1.3.-   1.1.5.-   1.1.98.-
1.10.2.-  1.10.3.-  1.11.1.-  1.13.11.- 1.14.-    1.14.11.- 1.14.12.-
1.14.13.- 1.14.14.- 1.14.19.- 1.14.99.- 1.16.8.-  1.18.1.-  1.2.-
1.2.1.-   1.2.7.-   1.3.1.-   1.3.8.-   1.3.98.-  1.3.99.-  1.4.3.-
1.5.-     1.5.1.-   1.5.3.-   1.5.5.-   1.5.99.-  1.6.3.-   1.7.99.-
1.8.-     1.8.1.-   1.8.4.-   1.97.-    2.-       2.1.-     2.1.1.-
2.1.3.-   2.2.1.-   2.3.-     2.3.1.-   2.3.2.-   2.4.-     2.4.1.-
2.4.2.-   2.4.99.-  2.5.1.-   2.6.1.-   2.7.-     2.7.1.-   2.7.10.-
2.7.11.-  2.7.4.-   2.7.7.-   2.7.8.-   2.8.1.-   2.8.2.-   2.8.3.-
3.-       3.1.-     3.1.1.-   3.1.11.-  3.1.13.-  3.1.2.-   3.1.21.-
3.1.22.-  3.1.25.-  3.1.26.-  3.1.27.-  3.1.3.-   3.1.4.-   3.1.5.-
3.1.6.-   3.2.-     3.2.1.-   3.2.2.-   3.3.-     3.4.-     3.4.11.-
3.4.13.-  3.4.14.-  3.4.16.-  3.4.17.-  3.4.19.-  3.4.21.-  3.4.22.-
3.4.23.-  3.4.24.-  3.4.25.-  3.5.-     3.5.1.-   3.5.4.-   3.5.99.-
3.6.-     3.6.1.-   3.6.3.-   3.6.4.-   3.6.5.-   3.7.1.-   4.-
4.1.-     4.1.1.-   4.1.2.-   4.2.1.-   4.2.2.-   4.2.3.-   4.2.99.-
4.3.2.-   4.4.1.-   4.5.1.-   5.-       5.1.3.-   5.3.1.-   5.3.3.-
5.4.3.-   5.4.99.-  6.-       6.1.1.-   6.2.1.-   6.3.-     6.3.1.-
6.3.2.-   6.3.5.-   6.4.1.-   6.5.1.-   7.-       7.2.2.-   7.3.-
7.5.2.-   7.6.2.-
```

## How this was generated

Computed directly against the live dataset, not estimated or sampled — for
each source: every distinct real id across all 128 samples' raw per-gene
files, minus every id present as a leaf node (`depth == 2` for COG,
`depth == 4` for KEGG/Enzyme) in the current `DataStructures/<Source>/*.json`
output. Both sides come from real, already-regenerated data, so this is an
exact accounting, not an approximation.

Each of the three tree-building notebooks prints its own drop count (and a
few example ids) every time it runs, so
this doc can be regenerated and compared against a fresh run to catch a
truncated/corrupted reference download — if the count jumps well above
what's listed here, that's the signal to look for.
