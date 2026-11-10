// Own totals for the categories the Explore views group the top annotations
// under (Dataset Overview, Annotations by Parent).
//
// A category's size is its own mean EGC, in which each gene counts once.
// Adding up its listed members is wrong both ways: members can overlap (a
// KEGG KO in several pathways counts in each), which made KEGG categories
// up to ~55% too large, and only the top 200 annotations are listed, which
// left COG categories at a third to a half of their real size.

import type { TopAnnotation } from '../types'
import { apiFetch } from './api'

// Keeps each request line well under common proxy limits (nginx: 8 KB),
// since taxonomy ids are whole lineages.
const MAX_URL_LENGTH = 6000

/**
 * Every category a listed row can be grouped under: its real parents when
 * known, otherwise its stored parent. A superset of the groups either view
 * builds, so no group goes without its own total.
 */
export function categoryIdsOf(
  rows:        TopAnnotation[],
  realParents: Record<string, { annotation_id: string }[]> | null,
): string[] {
  const ids = new Set<string>()
  for (const r of rows) {
    for (const p of realParents?.[r.annotation_id] ?? []) ids.add(p.annotation_id)
    if (r.parent != null) ids.add(r.parent)
  }
  return [...ids]
}

export type OwnTotal = { egc: number; name: string | null }

/**
 * Heading for an enzyme group: the term's own name when the server gave
 * one ("1.1.1 · With NAD+ or NADP+ as acceptor"), otherwise `fallback`.
 */
export function enzymeGroupLabel(id: string, fallback: string, own: OwnTotal | undefined): string {
  return own?.name ? `${id} · ${own.name}` : fallback
}

/**
 * {category id: own mean EGC and name} for each of `categoryIds` the server has,
 * over the same dates as `rows` (the list they were grouped from). Values
 * already in `rows` are used as they are; the rest are asked for with
 * /api/annotations/top?ids=, which works them out the same way.
 */
export async function fetchOwnTotals(
  source:      string,
  categoryIds: string[],
  rows:        TopAnnotation[],
  dateFrom = '',
  dateTo   = '',
): Promise<Record<string, OwnTotal>> {
  const known: Record<string, OwnTotal> = {}
  for (const r of rows) known[r.annotation_id] = { egc: r.mean_egc, name: r.name ?? null }
  const missing = categoryIds.filter(id => !(id in known))

  const base = `/api/annotations/top?source=${source}`
    + (dateFrom ? `&date_from=${dateFrom}` : '')
    + (dateTo ? `&date_to=${dateTo}` : '')
  const urls: string[] = []
  let url = base
  for (const id of missing) {
    const part = `&ids=${encodeURIComponent(id)}`
    if (url !== base && url.length + part.length > MAX_URL_LENGTH) {
      urls.push(url)
      url = base
    }
    url += part
  }
  if (url !== base) urls.push(url)

  const responses = await Promise.all(urls.map(u => apiFetch<{ data: TopAnnotation[] }>(u)))
  for (const r of responses) {
    for (const row of r.data ?? []) known[row.annotation_id] = { egc: row.mean_egc, name: row.name ?? null }
  }

  const totals: Record<string, OwnTotal> = {}
  for (const id of categoryIds) if (id in known) totals[id] = known[id]
  return totals
}
