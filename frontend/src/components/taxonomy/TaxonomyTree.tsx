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

import React from 'react'

import type { TaxonomyTreeNode } from '../../types'
import { taxonomyRankLabel } from '../../constants'
import { useTaxonomyTree } from '../../hooks/useTaxonomyTree'

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
    return <div className="tax-tree-status">Loading taxa…</div>
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
              : node.expanded ? 'Collapse' : 'Expand'
          }
        >
          {node.loadStatus === 'loading' ? '…' : node.expanded ? '▾' : '▸'}
        </button>

        <button
          className={`tax-node-checkbox ${isExcluded ? 'tax-node-checkbox-checked' : ''}`}
          onClick={() => onToggleExclude(node.annotationId)}
          title={
            isExcluded
              ? 'Include this taxon again'
              : 'Exclude this taxon (and everything under it) from the total'
          }
          aria-pressed={isExcluded}
        >
          {isExcluded && <span className="tax-node-checkbox-tick">✓</span>}
        </button>

        <span className="tax-node-name">{node.annotationId}</span>
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
