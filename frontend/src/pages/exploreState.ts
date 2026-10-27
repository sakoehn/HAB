// The Explore page state App.tsx keeps across navigation, and its default.

import type { ApiStatus, ExploreSection, ExploreSortCol, SortDir, TopAnnotation } from '../types'

export type ExploreState = {
  openSection:  ExploreSection | null
  source:       string
  limit:        number
  dateFrom:     string
  dateTo:       string
  rows:         TopAnnotation[]
  sampleCount:  number | null
  status:       ApiStatus
  // The (source, dateFrom, dateTo) that actually produced `rows` -- distinct from the live `source`/`dateFrom`/
  // `dateTo` above, which the user can change (dropdown/date fields) while
  // a request is still in flight. Every label/link/follow-up-fetch derived
  // from `rows` must read this instead of the live fields, or switching the
  // dropdown after loading would mislabel the still-displayed rows under
  // the new source. null until the first load completes.
  loadedParams: { source: string; dateFrom: string; dateTo: string } | null
  sortCol:      ExploreSortCol
  sortDir:      SortDir
  parentSource: string
  topFilter:    string
  // Rank/depth multi-select filter for the Top EGC Annotations table, for
  // any source — reads the row's real `depth` directly (/annotations/top
  // returns it for every source).
  topRankFilter: Set<number>
  // Lookup section
  lookupId:       string
  lookupSource:   string
  lookupResults:  TopAnnotation[]
  lookupSelected: TopAnnotation | null
  lookupTotal:    number
  lookupStatus:   ApiStatus
  // Same rationale as loadedParams above, for the lookup card's own
  // source -- otherwise switching lookupSource before a search resolves
  // would show the returned annotation tagged/linked under the NEW source.
  lookupLoadedSource: string | null
  // Same rank/depth filter, applied to the Lookup result list — reads
  // row.depth directly (from /api/search/annotations, real for every source).
  lookupRankFilter: Set<number>
  // Scaffold section
  scaffoldInitialTerms?: { annotationId: string; source: string }[]
  // Bulk Download section: a starting taxon handed over from another page
  // (a new object each time, so a repeat handoff of the same taxon applies)
  bulkDownloadInitialParent?: { lineage: string }
}

export function makeDefaultExploreState(): ExploreState {
  return {
    openSection:  null,
    source:       'taxonomy',
    limit:        25,
    dateFrom:     '',
    dateTo:       '',
    rows:         [],
    sampleCount:  null,
    status:       'idle',
    loadedParams: null,
    sortCol:      'mean_egc',
    sortDir:      'desc',
    parentSource: 'taxonomy',
    topFilter:    '',
    topRankFilter: new Set(),
    lookupId:       '',
    lookupSource:   'kegg',
    lookupResults:  [],
    lookupSelected: null,
    lookupTotal:    0,
    lookupStatus:   'idle',
    lookupLoadedSource: null,
    lookupRankFilter: new Set(),
    scaffoldInitialTerms: undefined,
    bulkDownloadInitialParent: undefined,
  }
}
