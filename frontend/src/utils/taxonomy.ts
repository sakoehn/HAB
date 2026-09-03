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

// computeExclusionSeries
// Given the scope root's full time series and the time series for each
// excluded node, compute a synthetic "root minus exclusions" series by
// joining on sample name and subtracting each excluded node's egc/norm_egc
// from the root's, per timepoint.
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
  excludedSeries: AnnotationItem[][],
  outputAnnotationId: string,
  outputName: string | null,
): AnnotationItem[] {
  const excludedEgcBySample = excludedSeries.map(series => {
    const m = new Map<string, number>()
    for (const item of series) {
      const egc = extractEgc(item.value)
      if (egc != null) m.set(item.sample, egc)
    }
    return m
  })
  const excludedNormBySample = excludedSeries.map(series => {
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

    for (let i = 0; i < excludedSeries.length; i++) {
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
