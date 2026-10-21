// The Analyze page state App.tsx keeps across navigation, and its default.

import type { AnnotationItem, ApiStatus, RightCard, SeriesCache } from '../types'

export type AnalyzeState = {
  queryFields:   string[]
  // The terms that actually produced
  // resultsByTerm/totalsByTerm, snapshotted at the moment runSearch() fired
  // -- distinct from queryFields, which keeps changing as the user types.
  // Tabs, labels, and any lookup indexed by term must all read this, not
  // the live text boxes, or e.g. typing "zinc" over "iron" results (without
  // re-searching) would relabel the still-showing iron results as "zinc".
  searchedTerms: string[]
  resultsByTerm: AnnotationItem[][]
  totalsByTerm:  number[]
  searchStatus:  ApiStatus
  activeTermIdx: number
  checkedByTerm: Record<string, Set<string>>
  rightCards:    RightCard[]
  seriesCache:   SeriesCache
  drawerOpen:    boolean
  drawerChecked: Set<string>
  // Set by another page that hands Analyze a query to look up ("View
  // Timeseries in Analyze"): run that search once on arrival, then clear.
  autoRunSearch?: boolean
}

export function makeDefaultAnalyzeState(): AnalyzeState {
  return {
    queryFields:   [''],
    searchedTerms: [],
    resultsByTerm: [],
    totalsByTerm:  [],
    searchStatus:  'idle',
    activeTermIdx: 0,
    checkedByTerm: {},
    rightCards:    [],
    seriesCache:   {},
    drawerOpen:    false,
    drawerChecked: new Set(),
  }
}
