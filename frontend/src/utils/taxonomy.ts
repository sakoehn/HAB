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
// separately would subtract that descendant's egc a second time (W19).
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

// bareTaxonName
// annotation_id for taxonomy is the full lineage-prefix (e.g.
// "Bacteria;Proteobacteria;Alphaproteobacteria") — the bare rank label is
// always its last segment, by construction of the full-lineage-prefix
// keying scheme (see taxonomy_egc_homonym_bug). Domain-level ids have no
// semicolon at all, so they pass through unchanged.

export function bareTaxonName(taxonId: string): string {
  const segments = taxonId.split(';')
  return segments[segments.length - 1]
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
// dedicated `category` field isn't (W7) -- e.g. row.annotation_id itself
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

export function computeChartTitle(rootId: string, excludedList: string[]): string {
  return excludedList.length === 0
    ? bareTaxonName(rootId)
    : `${bareTaxonName(rootId)} — Excluding ${excludedList.map(bareTaxonName).join(', ')}`
}
