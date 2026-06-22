// ── Shared Types ──────────────────────────────────────────────────────────────
// All TypeScript types, interfaces, and enums used across the application.
// Import from here rather than re-declaring in individual files.

// ── Primitive aliases ──────────────────────────────────────────────────────

export type ApiStatus = 'idle' | 'loading' | 'ok' | 'error'
export type Page      = 'analyze' | 'compare' | 'explore' | 'about'
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
  value:         unknown
  mean_egc?:     number | null
  max_egc?:      number | null
  sample_count?: number | null
}

export type TopAnnotation = {
  annotation_id: string
  name:          string | null
  parent:        string | null
  mean_egc:      number
  max_egc:       number
  sample_count:  number
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

// ── Chart / UI state ───────────────────────────────────────────────────────

export type NormalizeMode = 'none' | 'l1' | 'zscore'

// ── Shared annotation reference (used when passing between pages) ──────────

export type SharedAnnotation = {
  annotationId: string
  source:       string
  name:         string | null
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

export type CompareEntry = {
  annotationId: string
  source:       string
  name:         string | null
  data:         AnnotationItem[]
  status:       ApiStatus
  color:        string
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
  detailStatus:        ApiStatus
  detailShowAll:       boolean
  suggested:           boolean
}
