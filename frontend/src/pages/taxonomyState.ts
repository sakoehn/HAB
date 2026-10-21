// The Taxonomy page state App.tsx keeps across navigation, and its default.

import type { AnnotationItem, ApiStatus, SeriesCache } from '../types'

export type TaxonomyState = {
  rootId:            string | null
  rootQuery:         string
  rootSearchResults: AnnotationItem[]
  rootSearchStatus:  ApiStatus
  // How many taxa matched in all; more than rootSearchResults holds when
  // the server returned only its first page.
  rootSearchTotal:   number | null
  // The checked branches. Read as "remove these from the scope" or "keep only
  // these" depending on selectionMode -- switching modes keeps the same set.
  excludedIds:       Set<string>
  selectionMode:     'remove' | 'keep'
  seriesCache:       SeriesCache
  dateFrom:          string
  dateTo:            string
}

export function makeDefaultTaxonomyState(): TaxonomyState {
  return {
    rootId:            null,
    rootQuery:         '',
    rootSearchResults: [],
    rootSearchStatus:  'idle',
    rootSearchTotal:   null,
    excludedIds:       new Set(),
    selectionMode:     'remove',
    seriesCache:       {},
    dateFrom:          '',
    dateTo:            '',
  }
}
