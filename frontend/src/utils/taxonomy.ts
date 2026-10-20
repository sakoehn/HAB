// ── Taxonomy Utilities ────────────────────────────────────────────────────────
// Pure functions for taxonomy annotation ids and lineage math: computing
// "scope root minus excluded subtrees" series (Taxonomy Explorer only), plus
// general-purpose lineage-prefix helpers (bareTaxonName, taxonomyDepthFromId,
// computeChartTitle) used across Analyze/Compare/Explore/Taxonomy Explorer
// wherever a taxonomy annotation_id needs a short display label or its rank
// derived without a `depth` field on hand. No React imports — fully testable
// in Node.

import type { AnnotationItem } from '../types'
import { extractEgc, extractNormEgc } from './stats'

// isCoveredByAnotherExclusion / filterRedundantExclusions
// Taxonomy egc values are hierarchical rollups -- a taxon's own egc is the
// sum of everything under it (confirmed live: a domain's egc exactly
// equals the sum of its direct child phyla's egc, no rounding gap).
// Excluding a taxon therefore already zeroes out every one of its
// descendants' contributions; also excluding one of those descendants
// separately would subtract that descendant's egc a second time.
// Both helpers use the same rule (a taxonomy annotation_id IS its full
// lineage-prefix, so "is X a descendant of Y" is just a prefix check) --
// isCoveredByAnotherExclusion answers it for one id (used to decide
// whether to disable a single tree-row checkbox), filterRedundantExclusions
// for a whole list at once (used before summing).

export function isCoveredByAnotherExclusion(
  id: string,
  excludedIds: Iterable<string>,
): boolean {
  for (const other of excludedIds) {
    if (other !== id && id.startsWith(other + ';')) return true
  }
  return false
}

export function filterRedundantExclusions(excludedIds: string[]): string[] {
  return excludedIds.filter(id => !isCoveredByAnotherExclusion(id, excludedIds))
}

// computeExclusionSeries
// Given the scope root's full time series, the ids of each excluded node
// and their matching time series (parallel arrays), compute a synthetic
// "root minus exclusions" series by joining on sample name and subtracting
// each NON-REDUNDANT excluded node's egc/norm_egc from the root's, per
// timepoint. A descendant of another already-excluded id in the list is
// skipped (see filterRedundantExclusions above) rather than subtracted a
// second time.
//
// Join key: `sample` — the stable identifier present on every AnnotationItem.
//
// Missing-data semantics:
//   - Root has no entry for a given sample -> that sample is dropped from
//     the output entirely (nothing to subtract from).
//   - Root has an entry but an excluded node has no entry for that sample
//     -> treated as contributing 0 (the excluded taxon simply wasn't
//     observed in that sample), root value passes through unchanged for
//     that exclusion.
//
// The caller must supply an outputAnnotationId distinct from the root's own
// annotationId, since MultiEgcChart keys its per-timepoint rows by
// annotationId and two series sharing an id would collide.

export function computeExclusionSeries(
  rootSeries: AnnotationItem[],
  excludedIds: string[],
  excludedSeries: AnnotationItem[][],
  outputAnnotationId: string,
  outputName: string | null,
): AnnotationItem[] {
  const effectiveSeries = excludedIds
    .map((id, i) => ({ id, series: excludedSeries[i] }))
    .filter(({ id }) => !isCoveredByAnotherExclusion(id, excludedIds))
    .map(({ series }) => series)

  const excludedEgcBySample = effectiveSeries.map(series => {
    const m = new Map<string, number>()
    for (const item of series) {
      const egc = extractEgc(item.value)
      if (egc != null) m.set(item.sample, egc)
    }
    return m
  })
  const excludedNormBySample = effectiveSeries.map(series => {
    const m = new Map<string, number>()
    for (const item of series) {
      const norm = extractNormEgc(item.value)
      if (norm != null) m.set(item.sample, norm)
    }
    return m
  })

  const out: AnnotationItem[] = []
  for (const rootItem of rootSeries) {
    const rootEgc = extractEgc(rootItem.value)
    if (rootEgc == null) continue // root has no data for this sample -> drop

    const rootNorm = extractNormEgc(rootItem.value)
    let egc  = rootEgc
    let norm = rootNorm ?? 0

    for (let i = 0; i < effectiveSeries.length; i++) {
      egc  -= excludedEgcBySample[i].get(rootItem.sample) ?? 0
      norm -= excludedNormBySample[i].get(rootItem.sample) ?? 0
    }

    out.push({
      source:        rootItem.source,
      sample:        rootItem.sample,
      timepoint:     rootItem.timepoint,
      annotation_id: outputAnnotationId,
      name:          outputName,
      value:         { egc, norm_egc: rootNorm != null ? norm : null },
    })
  }
  return out
}

// computeInclusionSeries
// The Taxonomy page's "Keep only checked" line: per sample, the sum of only
// the checked branches -- the complement of computeExclusionSeries' "minus
// checked" line for the same checked set (the two add back up to the scope's
// full total). Same rules as the exclusion line: built on the scope's own
// sample axis (a sample where the scope has no value is dropped), a branch
// absent from a sample contributes 0, and a checked branch nested under
// another checked branch is skipped so nothing is counted twice.

export function computeInclusionSeries(
  rootSeries: AnnotationItem[],
  keptIds: string[],
  keptSeries: AnnotationItem[][],
  outputAnnotationId: string,
  outputName: string | null,
): AnnotationItem[] {
  const effective = keptIds
    .map((id, i) => ({ id, series: keptSeries[i] }))
    .filter(({ id }) => !isCoveredByAnotherExclusion(id, keptIds))
    .map(({ series }) => series)

  const egcBySample = effective.map(series => {
    const m = new Map<string, number>()
    for (const item of series) {
      const egc = extractEgc(item.value)
      if (egc != null) m.set(item.sample, egc)
    }
    return m
  })
  const normBySample = effective.map(series => {
    const m = new Map<string, number>()
    for (const item of series) {
      const norm = extractNormEgc(item.value)
      if (norm != null) m.set(item.sample, norm)
    }
    return m
  })

  const out: AnnotationItem[] = []
  for (const rootItem of rootSeries) {
    if (extractEgc(rootItem.value) == null) continue
    const rootNorm = extractNormEgc(rootItem.value)
    let egc  = 0
    let norm = 0
    for (let i = 0; i < effective.length; i++) {
      egc  += egcBySample[i].get(rootItem.sample) ?? 0
      norm += normBySample[i].get(rootItem.sample) ?? 0
    }
    out.push({
      source:        rootItem.source,
      sample:        rootItem.sample,
      timepoint:     rootItem.timepoint,
      annotation_id: outputAnnotationId,
      name:          outputName,
      value:         { egc, norm_egc: rootNorm != null ? norm : null },
    })
  }
  return out
}

// bareTaxonName
// annotation_id for taxonomy is the full lineage-prefix (e.g.
// "Bacteria;Proteobacteria;Alphaproteobacteria") — the bare rank label is
// always its last segment, by construction of the full-lineage-prefix
// keying scheme. Domain-level ids have no
// semicolon at all, so they pass through unchanged.

export function bareTaxonName(taxonId: string): string {
  const segments = taxonId.split(';')
  return segments[segments.length - 1]
}

// immediateParentSegment
// Two genuine cross-lineage homonyms (same bare name, different ancestry,
// e.g. Bosea under two different families) render identically wherever only
// bareTaxonName is shown, with nothing inviting the user to notice they're
// different taxa. The immediate parent (the lineage-prefix's second-to-
// last segment) is the cheapest real disambiguator available without
// showing the full lineage inline. null for a domain-level id (a single
// segment, no parent above it).

export function immediateParentSegment(taxonId: string): string | null {
  const segments = taxonId.split(';')
  return segments.length >= 2 ? segments[segments.length - 2] : null
}

// taxonomyDepthFromId
// The rank (1=domain..8=strain) is just the lineage-prefix's segment
// count — usable anywhere a taxonomy id is available but the record
// itself doesn't carry a `depth` field (e.g. /annotations/top, which
// only annotation_catalog/search results carry depth on).

export function taxonomyDepthFromId(taxonId: string): number {
  return taxonId.split(';').length
}

// taxonomyDomainFromId
// The domain root ("Bacteria" | "Archaea" | "Eukaryota" | "Viruses") is
// always the lineage-prefix's first segment. Used to pass the right domain
// into taxonomyRankLabel() wherever a taxon id is available but a
// dedicated `category` field isn't -- e.g. row.annotation_id itself
// works, since it IS the full lineage prefix.

export function taxonomyDomainFromId(taxonId: string): string {
  return taxonId.split(';')[0]
}

// computeChartTitle
// Builds the Taxonomy Explorer chart title: the scope root's name, plus
// the excluded branches when there are any. Used instead of MultiEgcChart's
// generic "{yLabel} — N Annotations" default, which doesn't say what's
// actually being shown. Both the root and each exclusion are reduced to
// their bare rank label — the full lineage is still one hover/click away
// (the chart legend and info drawer), just not crammed into the title.

export function computeChartTitle(rootId: string, excludedList: string[], mode: 'remove' | 'keep' = 'remove'): string {
  return excludedList.length === 0
    ? bareTaxonName(rootId)
    : `${bareTaxonName(rootId)} — ${mode === 'keep' ? 'Only' : 'Excluding'} ${excludedList.map(bareTaxonName).join(', ')}`
}
