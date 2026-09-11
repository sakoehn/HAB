// ── Shared Types ──────────────────────────────────────────────────────────────
// All TypeScript types, interfaces, and enums used across the application.
// Import from here rather than re-declaring in individual files.

// ── Primitive aliases ──────────────────────────────────────────────────────

export type ApiStatus = 'idle' | 'loading' | 'ok' | 'error'
export type Page      = 'analyze' | 'compare' | 'explore' | 'taxonomy' | 'about'
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
  // Only present on rows from /api/search/annotations (annotation_catalog
  // carries it; /api/annotations/top's aggregation does not) — taxonomic
  // rank, 1=domain..8=strain. Null/undefined for cog (see create_sql_schema.py).
  depth?:         number | null
  // Also only on /api/search/annotations rows — a single-source
  // /annotations/top request has no need to repeat its own source per row.
  source?:        string
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
  lag_samples:   number
  lag_hours:     number
  n_pairs:       number
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

export type MappingSortCol  = 'date' | 'time' | 'taxonomy' | 'kegg_id' | 'enzyme' | 'cog_id'
export type ExploreSortCol  = 'mean_egc' | 'max_egc' | 'sample_count' | 'annotation_id'
export type ScaffoldSortCol = 'date' | 'scaffold_count' | 'gene_count'

// ── Explore section tabs ───────────────────────────────────────────────────

export type ExploreSection = 'overview' | 'top-egc' | 'by-parent' | 'lookup' | 'scaffolds'

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
