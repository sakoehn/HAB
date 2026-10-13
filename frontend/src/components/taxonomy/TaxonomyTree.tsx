// ── TaxonomyTree ──────────────────────────────────────────────────────────────
// Expandable taxonomy tree, re-rooted at a chosen scope taxon's own children
// (so the user can only ever exclude things inside the current scope).
// Children are lazily loaded (via useTaxonomyTree) on first expand and cached
// in local state so re-collapsing/re-expanding doesn't refetch.
//
// Exclusion state (which taxa are excluded from the aggregate) is owned by
// the parent page and passed down as a controlled Set<string>, following the
// same controlled-checkbox pattern as LeftResultList.
//
// Excluding a node disables expanding its own children — nothing under an
// already-excluded node can be separately excluded, so there's no reason to
// let the user drill into it.
//
// That alone doesn't cover every path to a double-subtraction, though
// (W19): a descendant can already be visible/expanded from BEFORE its
// ancestor got excluded, and nothing stopped it from also being checked.
// Excluding an ancestor already zeroes out everything under it (taxonomy
// egc values are hierarchical rollups), so also excluding one of its own
// descendants would subtract that descendant a second time. Every row's
// checkbox is disabled when isCoveredByAnotherExclusion says its own id is
// a descendant of a currently-excluded id -- computeExclusionSeries also
// filters these out defensively when summing, so correctness doesn't
// depend on this UI guard alone.

import type { TaxonomyTreeNode } from '../../types'
import { taxonomyRankLabel } from '../../constants'
import { isCoveredByAnotherExclusion } from '../../utils/taxonomy'
import { useTaxonomyTree } from '../../hooks/useTaxonomyTree'
import { SkeletonTreeRows } from '../ui/Skeleton'

export function TaxonomyTree({
  rootId,
  excludedIds,
  onToggleExclude,
}: {
  rootId:          string
  excludedIds:     Set<string>
  onToggleExclude: (annotationId: string) => void
}) {
  const { nodes, status, toggleExpand } = useTaxonomyTree(rootId)

  if (status === 'loading' && nodes.length === 0) {
    return (
      <>
        <span className="sr-only">Loading taxa…</span>
        <SkeletonTreeRows rows={5} />
      </>
    )
  }
  if (status === 'error') {
    return <div className="tax-tree-status tax-tree-error">Failed to load taxonomy tree.</div>
  }
  if (status === 'ok' && nodes.length === 0) {
    return <div className="tax-tree-status">No child taxa under this scope.</div>
  }

  // A node can't be drilled into once it's excluded — nothing under it can
  // be separately excluded, so there's nothing useful to expand.
  const canExpand = (node: TaxonomyTreeNode) => !excludedIds.has(node.annotationId)

  return (
    <div className="tax-tree">
      {nodes.map(node => (
        <TaxonomyNodeRow
          key={node.annotationId}
          node={node}
          excludedIds={excludedIds}
          onToggleExclude={onToggleExclude}
          onToggleExpand={node => toggleExpand(node, canExpand)}
        />
      ))}
    </div>
  )
}

function TaxonomyNodeRow({
  node,
  excludedIds,
  onToggleExclude,
  onToggleExpand,
}: {
  node:            TaxonomyTreeNode
  excludedIds:     Set<string>
  onToggleExclude: (annotationId: string) => void
  onToggleExpand:  (node: TaxonomyTreeNode) => void
}) {
  const isExcluded = excludedIds.has(node.annotationId)
  const isCovered  = !isExcluded && isCoveredByAnotherExclusion(node.annotationId, excludedIds)
  const rank       = taxonomyRankLabel(node.depth, node.category)

  return (
    <div className="tax-node">
      <div className={`tax-node-row ${isExcluded ? 'tax-node-excluded' : ''}`}>
        <button
          className="tax-node-chevron"
          onClick={() => onToggleExpand(node)}
          disabled={isExcluded || node.loadStatus === 'loading'}
          title={
            isExcluded
              ? 'Cannot drill into an excluded taxon'
              : node.loadStatus === 'error'
                ? 'Failed to load children — click to retry'
                : node.expanded ? 'Collapse' : 'Expand'
          }
        >
          {node.loadStatus === 'loading' ? '…' : node.expanded ? '▾' : '▸'}
        </button>

        {/* G8/G12 (docs/AUDIT-2026-10-05.md): see HierarchyTree's matching
            comment -- a failed child fetch left loadStatus:'error' with
            nothing rendering it, indistinguishable from a row that was
            simply never clicked. */}
        {!isExcluded && node.loadStatus === 'error' && (
          <span className="tax-node-load-error" title="Failed to load children — click ▸ to retry">
            ⚠
          </span>
        )}

        <button
          className={`tax-node-checkbox ${isExcluded ? 'tax-node-checkbox-checked' : ''}`}
          onClick={() => onToggleExclude(node.annotationId)}
          disabled={isCovered}
          title={
            isCovered
              ? 'Already excluded via an ancestor taxon -- excluding it separately would subtract it twice'
              : isExcluded
                ? 'Include this taxon again'
                : 'Exclude this taxon (and everything under it) from the total'
          }
          aria-pressed={isExcluded}
        >
          {isExcluded && <span className="tax-node-checkbox-tick">✓</span>}
        </button>

        <span className="tax-node-name">{node.name}</span>
        <span className="tax-node-rank">{rank}</span>
      </div>

      {node.expanded && node.children.length > 0 && (
        <div className="tax-node-children">
          {node.children.map(child => (
            <TaxonomyNodeRow
              key={child.annotationId}
              node={child}
              excludedIds={excludedIds}
              onToggleExclude={onToggleExclude}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  )
}
