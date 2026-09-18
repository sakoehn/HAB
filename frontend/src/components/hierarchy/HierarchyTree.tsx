// ── HierarchyTree ────────────────────────────────────────────────────────────
// Read-only expandable tree for browsing a KEGG/COG/Enzyme hierarchy inside
// the hierarchy popup. Modeled on TaxonomyBrowseTree.tsx's rows (chevron +
// plain name, no checkbox, no click-to-select -- this is pure browsing, not
// a scope picker), reusing the same .tax-node-* CSS classes.
//
// Presentational only -- nodes/highlightId/onToggleExpand are owned by
// HierarchyModal (which also drives the initial expand-to-path), not fetched
// here, since the modal needs the same useHierarchyTree instance to call
// expandToPath() once on open.

import { useEffect, useRef } from 'react'

import type { HierarchyTreeNode } from '../../types'

export function HierarchyTree({
  nodes,
  highlightId,
  onToggleExpand,
}: {
  nodes:          HierarchyTreeNode[]
  highlightId:    string | null
  onToggleExpand: (node: HierarchyTreeNode) => void
}) {
  if (nodes.length === 0) {
    return <div className="tax-tree-status">No entries under this node.</div>
  }

  return (
    <div className="tax-tree">
      {nodes.map(node => (
        <HierarchyNodeRow
          key={node.annotationId}
          node={node}
          highlightId={highlightId}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </div>
  )
}

function HierarchyNodeRow({
  node,
  highlightId,
  onToggleExpand,
}: {
  node:           HierarchyTreeNode
  highlightId:    string | null
  onToggleExpand: (node: HierarchyTreeNode) => void
}) {
  const isHighlighted = node.annotationId === highlightId
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // scrollIntoView isn't implemented in jsdom (test environment) --
    // guard the call itself, not just the ref, so tests don't need to
    // stub it out.
    if (isHighlighted) rowRef.current?.scrollIntoView?.({ block: 'center' })
  }, [isHighlighted])

  return (
    <div className="tax-node">
      <div
        ref={rowRef}
        className={`tax-node-row${isHighlighted ? ' hier-node-highlighted' : ''}`}
      >
        <button
          className="tax-node-chevron"
          onClick={() => onToggleExpand(node)}
          disabled={node.loadStatus === 'loading'}
          title={node.expanded ? 'Collapse' : 'Expand'}
        >
          {node.loadStatus === 'loading' ? '…' : node.expanded ? '▾' : '▸'}
        </button>

        <span className="tax-node-name">{node.name}</span>
      </div>

      {node.expanded && node.children.length > 0 && (
        <div className="tax-node-children">
          {node.children.map(child => (
            <HierarchyNodeRow
              key={child.annotationId}
              node={child}
              highlightId={highlightId}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  )
}
