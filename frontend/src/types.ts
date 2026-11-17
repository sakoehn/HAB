// ── Shared Types ──────────────────────────────────────────────────────────────
// All TypeScript types, interfaces, and enums used across the application.
// Import from here rather than re-declaring in individual files.

// ── Primitive aliases ──────────────────────────────────────────────────────

export type ApiStatus = 'idle' | 'loading' | 'ok' | 'error'
export type Page      = 'analyze' | 'compare' | 'explore' | 'taxonomy' | 'methods' | 'about'
export type SortDir   = 'asc' | 'desc'
export type Theme     = 'dark' | 'light'

// ── Annotation sources ─────────────────────────────────────────────────────

export type AnnotationSourceKey = 'kegg' | 'cog' | 'enzyme' | 'taxonomy'

// ── Timepoint metadata ─────────────────────────────────────────────────────

export type TimepointMeta = {
  taxon_oid: string
  timepoint: string
  datetime:  string
}

// ── Core annotation data ───────────────────────────────────────────────────

export type AnnotationItem = {
  source:        string
  sample:        string
  timepoint:     TimepointMeta | null
  annotation_id: string
  name:          string | null
  depth?:        number | null
  value:         unknown
  mean_egc?:     number | null
  max_egc?:      number | null
  sample_count?: number | null
}

// Shape of the per-annotation JSON entry returned in the `value` field by
// /search/annotations.  Fields are all optional because the schema varies
// by source type (taxonomy omits name/parent_id/parent_name; the egc and
// norm_egc values are from the first sample seen, not aggregates).
export type AnnotationValue = {
  name?:        string | null
  depth?:       number | null
  category?:    string | null
  parent_id?:   string | null
  parent_name?: string | null
  parent?:      string | null   // taxonomy uses 'parent' instead of parent_id
  egc?:         number | null
  norm_egc?:    number | null
  scaffolds?:   Record<string, number> | null
}

// ── Taxonomy Explorer ───────────────────────────────────────────────────────

// Response row shape from GET /taxonomy/children.
export type TaxonomyChildNode = {
  annotation_id: string
  name:          string
  depth:         number | null
  category:      string | null
}

// Client-side expandable-tree node. Children are populated lazily on first
// expand; childrenLoaded distinguishes "not fetched yet" from "fetched, zero
// children" (a leaf taxon).
export type TaxonomyTreeNode = {
  annotationId:   string
  depth:          number | null
  name:           string
  category:       string | null
  expanded:       boolean
  loadStatus:     ApiStatus
  childrenLoaded: boolean
  children:       TaxonomyTreeNode[]
}

// ── Hierarchy popup (COG / Enzyme browse tree) ─────────────────────────────
// Source key for the hierarchy popup. Excludes 'taxonomy', which has its own
// tree (TaxonomyTree/TaxonomyPage), and 'kegg': KEGG orthologs are a flat
// list with no hierarchy.
export type HierarchySource = 'cog' | 'enzyme'

// Response row shape from GET /{source}/children.
export type HierarchyChildNode = {
  annotation_id: string
  name:          string
  depth:         number | null
  category:      string | null
}

// One real ancestor chain, root-to-node order.
export type HierarchyPathNode = { annotation_id: string; name: string; depth: number }

// Response shape from GET /{source}/path. `paths` holds every real
// ancestor chain for annotation_id, sorted by first real occurrence -- a
// COG in several functional categories has one per category (e.g. COG0028
// is under both E and H); an Enzyme node always has exactly 1.
export type HierarchyPathResponse = {
  annotation_id: string
  paths:         HierarchyPathNode[][]
  path_count:    number
}

// Client-side expandable-tree node -- same lazy-load shape as
// TaxonomyTreeNode. There's no `highlighted` field here: the tree
// component compares each node's id against the hook's `highlightId`
// at render time instead of storing highlight state per-node.
export type HierarchyTreeNode = {
  annotationId:   string
  depth:          number | null
  name:           string
  category:       string | null
  expanded:       boolean
  loadStatus:     ApiStatus
  childrenLoaded: boolean
  children:       HierarchyTreeNode[]
}

export type TopAnnotation = {
  annotation_id:  string
  name:           string | null
  parent:         string | null
  mean_egc:       number
  max_egc:        number
  mean_norm_egc?: number | null
  max_norm_egc?:  number | null
  sample_count:   number
  value?:         AnnotationValue | null
  // Taxonomic rank, 1=domain..8=strain for taxonomy; hierarchy-tree depth
  // for cog/enzyme; always 1 for kegg (a flat list of KOs). Present on
  // both /api/annotations/top and /api/search/annotations rows -- needed to
  // rank-filter down to real leaf annotations, since a parent's EGC is the
  // sum of its descendants and so always outranks its leaves by mean_egc.
  depth?:         number | null
  // Also only on /api/search/annotations rows — a single-source
  // /annotations/top request has no need to repeat its own source per row.
  source?:        string
  // Only on /api/search/annotations rows: how closely the row matched the
  // search text. Results come exact first, then starts, then contains.
  match?:         'exact' | 'starts' | 'contains'
  // Top-level fields from /api/search/annotations (see
  // resolveLookupCategory/resolveLookupScaffoldCount in utils/stats.ts,
  // which also accept the nested `value` shape). category is exact
  // (identical for every sample of a given annotation); scaffold_count is
  // a real count from *a* sample, not a specific one.
  category?:       string | null
  scaffold_count?: number | null
}

// ── Mapping row types ──────────────────────────────────────────────────────

export type MappingRow = {
  gene_id:   string | null
  contig_id: string | null
  taxonomy:  string | null
  kegg_id:   string | null
  enzyme:    string | null
  cog_id:    string | null
}

export type MappingSearchRow = MappingRow & {
  sample:    string
  timepoint: TimepointMeta | null
}

// ── Scaffold data ──────────────────────────────────────────────────────────

export type ScaffoldSummaryRow = {
  sample:         string
  date:           string
  scaffold_count: number
  gene_count:     number
}

export type ScaffoldDetailRow = {
  sample:   string
  date:     string
  scaffold: string
  count:    number
}

// ── Correlation results ────────────────────────────────────────────────────
// Legacy shape from /api/annotations/correlate (JSON backend, CLR +
// permutation p-values). Superseded for the SQL backend by
// CorrelationFamilyResult below (/api/correlations/family, Bonferroni+FDR).

export type CorrelateResult = {
  annotation_id: string
  source:        string
  name:          string | null
  parent:        string | null
  spearman_r:    number
  abs_r:         number
  lag_samples:   number
  lag_hours:     number
  p_value:       number | null
  n_pairs:       number
}

export type CorrMethod = 'spearman' | 'log_pearson' | 'raw_pearson'

export type CorrelationFamilyResult = {
  catalog_id:    number
  annotation_id: string
  name:          string | null
  depth:         number | null
  r:             number
  p:             number
  q:             number
  significant:   boolean   // q < 0.05
  lag_samples:   number
  lag_hours:     number
  n_pairs:       number
}

// /api/correlations/family's real response envelope (not a bare array).
// `results` is every scored candidate ranked by |r| (capped at the
// request's limit), significant or not.
export type CorrelationFamilyResponse = {
  results:           CorrelationFamilyResult[]
  // True totals BEFORE `limit` truncates `results`, so the panel can show
  // "top 50 of 4,637 tested, 3 significant" instead of a bare 50.
  significant_count: number
  tested_count:      number
  // Candidates that couldn't be scored, and why: fewer than 10 shared
  // timepoints at every lag, no variation where they overlap, or a score
  // that came out non-finite ("other"). The reasons add up to
  // untested_count.
  untested_count:    number
  untested_reasons?: { too_few_points: number; no_variation: number; other: number }
}

// ── Chart / UI state ───────────────────────────────────────────────────────
// Metric and standardize are independent: any metric can be combined with
// standardize on or off (e.g. Z-scored Relative Abundance).

export type ChartMetric = 'egc' | 'norm_egc'

// ── Shared annotation reference (used when passing between pages) ──────────
// Discriminated union: single annotations pass directly; group cards pass
// their label and full member list so ComparePage can reconstruct the sum.

export type SharedAnnotationMember = {
  annotationId: string
  source:       string
}

export type SharedAnnotation =
  | {
      kind:         'single'
      annotationId: string
      source:       string
      name:         string | null
    }
  | {
      kind:    'group'
      label:   string
      members: SharedAnnotationMember[]
    }

// ── Series data cache ──────────────────────────────────────────────────────

export type SeriesCache = Record<string, { data: AnnotationItem[]; status: ApiStatus }>

// ── Right-column card types (Analyze page) ─────────────────────────────────
// A card is either a single annotation chart or a grouped/summed chart.

export type RightCard =
  | {
      kind:         'single'
      key:          string
      annotationId: string
      source:       string
      name:         string | null
      depth:        number | null
      color:        string
      parent:       string | null
    }
  | {
      kind:          'group'
      key:           string
      label:         string
      annotationIds: string[]
      sources:       string[]
    }

// ── Compare page entry ─────────────────────────────────────────────────────
// A single-annotation entry carries one series directly.
// A group entry carries the summed series plus the raw member series for
// the expand toggle — members are fetched once and cached in memberData.

export type CompareEntryMember = {
  annotationId: string
  source:       string
  data:         AnnotationItem[]
  status:       ApiStatus
}

export type CompareEntry = {
  // Stable, unique id (crypto.randomUUID()), assigned once at entry
  // creation -- used ONLY for series keying (MultiEgcChart), never for
  // display.
  // `annotationId` alone can't serve that role: for a group it's just the
  // user-typed label, and two different groups (different, unrelated
  // members) can share the exact same label.
  id:              string
  // Display identity
  annotationId:    string          // annotation_id for singles; group label for groups
  source:          string          // source for singles; first member source for groups
  name:            string | null
  color:           string
  // Series data (summed for groups, raw for singles)
  data:            AnnotationItem[]
  status:          ApiStatus
  // Group-only fields (undefined for singles)
  isGrouped?:      boolean
  members?:        CompareEntryMember[]
  membersExpanded?: boolean
}

// ── Descriptive statistics ─────────────────────────────────────────────────

export type DescStats = {
  n:      number
  mean:   number
  median: number
  std:    number
  min:    number
  max:    number
  q1:     number
  q3:     number
  cv:     number
}

// ── Sort column types (used in table headers) ──────────────────────────────

export type MappingSortCol  = 'date' | 'time' | 'gene_id' | 'contig_id' | 'taxonomy' | 'kegg_id' | 'enzyme' | 'cog_id'
export type ExploreSortCol  = 'mean_egc' | 'max_egc' | 'sample_count' | 'annotation_id'
export type ScaffoldSortCol = 'date' | 'scaffold_count' | 'gene_count'

// ── Explore section tabs ───────────────────────────────────────────────────

// A starting term handed to Explore > Bulk Download (see exploreState.ts).
export type BulkDownloadHandoff = { lineage: string; source?: string; depth?: number; name?: string }

export type ExploreSection = 'overview' | 'top-egc' | 'by-parent' | 'lookup' | 'scaffolds' | 'bulk-download'

// ── Correlates tab ─────────────────────────────────────────────────────────

export type CorrTab = 'cross' | 'within'

// ── Scaffold explore term ──────────────────────────────────────────────────

export type ScaffoldExploreTerm = {
  annotationId:        string
  source:              string
  summary:             ScaffoldSummaryRow[]
  status:              ApiStatus
  color:               string
  expanded:            boolean
  expandedSample:      string | null
  detailRows:          ScaffoldDetailRow[]
  detailTotal:         number
  detailStatus:        ApiStatus
  detailShowAll:       boolean
  detailLoadingMore:   boolean
  suggested:           boolean
  chartVisible:        boolean
}
