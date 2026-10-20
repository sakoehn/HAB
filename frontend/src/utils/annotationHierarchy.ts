// ── annotationHierarchy ──────────────────────────────────────────────────────
// filterRedundantAnnotations: given a list of annotations a user wants to
// SUM together, drops any that are already contained inside another one in
// the same list -- summing both double-counts the contained one's value.
//
// egc/scaffold/gene counts are hierarchical rollups (a parent's value
// exactly equals the sum of its children's, no rounding gap -- the same
// invariant the taxonomy-exclusion version of this check relies on). Summing e.g. Bacteria AND
// Proteobacteria together doesn't give "everything in either" -- it gives
// Bacteria's total plus a second, redundant copy of everything under
// Proteobacteria, since Proteobacteria's value was already inside
// Bacteria's. E.g. summing just 3 nested taxonomy terms (Bacteria ⊃
// Proteobacteria ⊃ Alphaproteobacteria) gives 375,910 scaffolds where the
// true distinct count is 198,368.
//
// Two detection strategies, dispatched per source:
//   - taxonomy: annotation_id IS the full lineage-prefix, so "is A an
//     ancestor of B" is a free string-prefix check -- no fetch needed.
//     Mirrors utils/taxonomy.ts's isCoveredByAnotherExclusion (built for
//     the taxonomy-exclusion case), generalized here for the sum case.
//   - kegg/cog/enzyme: no such shortcut -- a candidate only carries its
//     immediate parent, not a full ancestor chain, and KEGG nodes can have
//     multiple real parents (e.g. K00844/hexokinase has 14). Fetches each
//     candidate's real ancestor path(s) from the existing /{source}/path
//     endpoint (built for the hierarchy popup, root-to-node order,
//     INCLUDES the node itself as the last element) and checks whether any
//     other candidate in the group appears earlier in any of those paths.
//
// Only ever compares candidates within the SAME source -- a taxonomy node
// can't contain a KEGG node.

import { apiFetch } from './api'
import type { HierarchyPathResponse, HierarchySource } from '../types'

export type RedundancyCandidate = {
  annotationId: string
  source:       string
}

export type DroppedRedundancy = {
  candidate:   RedundancyCandidate
  containedBy: RedundancyCandidate
}

export type RedundancyResult = {
  kept:    RedundancyCandidate[]
  dropped: DroppedRedundancy[]
}

function isTaxonomyDescendant(id: string, ofId: string): boolean {
  return id.startsWith(ofId + ';')
}

const HIERARCHY_SOURCES = new Set<string>(['kegg', 'cog', 'enzyme'])

export async function filterRedundantAnnotations(
  candidates: RedundancyCandidate[],
): Promise<RedundancyResult> {
  const dropped: DroppedRedundancy[] = []
  const containedByKey = new Map<string, RedundancyCandidate>() // candidate key -> ancestor that contains it

  const keyOf = (c: RedundancyCandidate) => `${c.source}::${c.annotationId}`

  // ── Taxonomy: free prefix check, no fetch ──────────────────────────────
  const taxonomyCandidates = candidates.filter(c => c.source === 'taxonomy')
  for (const b of taxonomyCandidates) {
    for (const a of taxonomyCandidates) {
      if (a.annotationId === b.annotationId) continue
      if (isTaxonomyDescendant(b.annotationId, a.annotationId)) {
        containedByKey.set(keyOf(b), a)
        break
      }
    }
  }

  // ── KEGG / COG / Enzyme: fetch real ancestor paths ─────────────────────
  for (const source of HIERARCHY_SOURCES) {
    const group = candidates.filter(c => c.source === source)
    if (group.length < 2) continue // nothing to compare against

    const ancestorsById = new Map<string, Set<string>>()
    await Promise.all(
      group.map(async c => {
        try {
          const res = await apiFetch<HierarchyPathResponse>(
            `/api/${source as HierarchySource}/path?id=${encodeURIComponent(c.annotationId)}`,
          )
          const ancestors = new Set<string>()
          for (const path of res.paths ?? []) {
            // root-to-node order, node itself is the last element -- every
            // earlier entry is a real ancestor.
            for (const node of path.slice(0, -1)) ancestors.add(node.annotation_id)
          }
          ancestorsById.set(c.annotationId, ancestors)
        } catch {
          // A failed path lookup means "unknown", not "no ancestors" --
          // fail safe by keeping the candidate rather than risking an
          // incorrect drop from an incomplete answer.
          ancestorsById.set(c.annotationId, new Set())
        }
      }),
    )

    for (const b of group) {
      const bAncestors = ancestorsById.get(b.annotationId)
      if (!bAncestors) continue
      for (const a of group) {
        if (a.annotationId === b.annotationId) continue
        if (bAncestors.has(a.annotationId)) {
          containedByKey.set(keyOf(b), a)
          break
        }
      }
    }
  }

  const kept: RedundancyCandidate[] = []
  for (const c of candidates) {
    const containedBy = containedByKey.get(keyOf(c))
    if (containedBy) {
      dropped.push({ candidate: c, containedBy })
    } else {
      kept.push(c)
    }
  }

  return { kept, dropped }
}
