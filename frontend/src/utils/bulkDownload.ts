// Pure helpers for the Explore page's Bulk Download section
// (components/download/BulkDownloadPanel.tsx).

import { TAXONOMY_RANK_NAMES } from '../constants'

type RankOption = { value: string; label: string; depth: number }

// Levels each source can be downloaded at, top level first. Values are the
// lowercase names /api/series/export takes.
const LEVELS: Record<string, RankOption[]> = {
  taxonomy: Object.entries(TAXONOMY_RANK_NAMES)
    .map(([depth, label]) => ({ value: label.toLowerCase(), label, depth: Number(depth) }))
    .sort((a, b) => a.depth - b.depth),
  enzyme: [
    { value: 'class',       label: 'Class',        depth: 1 },
    { value: 'subclass',    label: 'Subclass',     depth: 2 },
    { value: 'subsubclass', label: 'Sub-subclass', depth: 3 },
    { value: 'ec',          label: 'EC number',    depth: 4 },
  ],
}

// Levels of `source` below `parentDepth` (0 for the whole dataset).
export function levelOptionsBelow(source: string, parentDepth: number): RankOption[] {
  return (LEVELS[source] ?? []).filter(o => o.depth > parentDepth)
}

// Display name of a source's level, e.g. ('enzyme', 3) -> 'Sub-subclass'.
export function levelLabel(source: string, depth: number): string | undefined {
  return LEVELS[source]?.find(o => o.depth === depth)?.label
}

// Ranks deeper than `parent` (a full taxonomy lineage), or every rank for
// the whole dataset (null).
export function rankOptionsBelow(parent: string | null): RankOption[] {
  return levelOptionsBelow('taxonomy', parent ? parent.split(';').length : 0)
}

export function buildExportQuery({ source, parent, rank, dateFrom, dateTo, includeParent = false }: {
  source:         string
  parent:         string | null
  rank:           string
  dateFrom:       string
  dateTo:         string
  includeParent?: boolean
}): string {
  const q = new URLSearchParams({ source, rank })
  if (parent)   q.set('parent', parent)
  if (dateFrom) q.set('date_from', dateFrom)
  if (dateTo)   q.set('date_to', dateTo)
  if (parent && includeParent) q.set('include_parent', 'true')
  return q.toString()
}
