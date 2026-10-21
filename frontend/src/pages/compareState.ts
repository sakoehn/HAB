// The Compare page state App.tsx keeps across navigation, and its default.

import type { AnnotationItem, ApiStatus, CompareEntry } from '../types'

export type CompareState = {
  query:         string
  searchResults: AnnotationItem[]
  searchStatus:  ApiStatus
  entries:       CompareEntry[]
  showMappings:  boolean
  dateFrom:      string
  dateTo:        string
}

export function makeDefaultCompareState(): CompareState {
  return {
    query:         '',
    searchResults: [],
    searchStatus:  'idle',
    entries:       [],
    showMappings:  false,
    dateFrom:      '',
    dateTo:        '',
  }
}
