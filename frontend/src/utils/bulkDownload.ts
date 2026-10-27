// Pure helpers for the Explore page's Bulk Download section
// (components/download/BulkDownloadPanel.tsx).

import { TAXONOMY_RANK_NAMES } from '../constants'

type RankOption = { value: string; label: string; depth: number }

// Ranks deeper than `parent` (a full lineage), or every rank for the whole
// dataset (null). Values are the lowercase names /api/series/export takes.
export function rankOptionsBelow(parent: string | null): RankOption[] {
  const parentDepth = parent ? parent.split(';').length : 0
  return Object.entries(TAXONOMY_RANK_NAMES)
    .map(([depth, label]) => ({ value: label.toLowerCase(), label, depth: Number(depth) }))
    .filter(o => o.depth > parentDepth)
    .sort((a, b) => a.depth - b.depth)
}

export function buildExportQuery({ source, parent, rank, dateFrom, dateTo }: {
  source:   string
  parent:   string | null
  rank:     string
  dateFrom: string
  dateTo:   string
}): string {
  const q = new URLSearchParams({ source, rank })
  if (parent)   q.set('parent', parent)
  if (dateFrom) q.set('date_from', dateFrom)
  if (dateTo)   q.set('date_to', dateTo)
  return q.toString()
}
