// ── Taxonomy Explorer Utilities ──────────────────────────────────────────────
// Pure functions for computing "scope root minus excluded subtrees" series.
// No React imports — fully testable in Node.

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

// computeChartTitle
// Builds the Taxonomy Explorer chart title: the scope root's name, plus
// the excluded branches when there are any. Used instead of MultiEgcChart's
// generic "{yLabel} — N Annotations" default, which doesn't say what's
// actually being shown.

export function computeChartTitle(rootId: string, excludedList: string[]): string {
  return excludedList.length === 0
    ? rootId
    : `${rootId} — Excluding ${excludedList.join(', ')}`
}
