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
  status,
  onSelect,
}: {
  nodes:          HierarchyTreeNode[]
  highlightId:    string | null
  onToggleExpand: (node: HierarchyTreeNode) => void
  // When given, every name is a button that picks that node (the Bulk
  // Download browse tree); the popup leaves it out, so names stay text.
  onSelect?:      (node: HierarchyTreeNode) => void
  // A failed root fetch leaves `nodes` empty exactly the same way a
  // genuinely childless root would, so callers pass `status` -- this
  // is reachable even when the popup's own path lookup (HierarchyModal's
  // pathStatus) succeeds, since goToPath's root-children fetch is a
  // separate request. Optional only so existing callers that never pass
  // it keep their old (ambiguous) behavior rather than a type error.
  status?: 'idle' | 'loading' | 'ok' | 'error'
}) {
  if (status === 'error') {
    return <div className="tax-tree-status tax-tree-error">Failed to load hierarchy tree.</div>
  }
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
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function HierarchyNodeRow({
  node,
  highlightId,
  onToggleExpand,
  onSelect,
}: {
  node:           HierarchyTreeNode
  highlightId:    string | null
  onToggleExpand: (node: HierarchyTreeNode) => void
  onSelect?:      (node: HierarchyTreeNode) => void
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
          title={
            node.loadStatus === 'error'
              ? 'Failed to load children — click to retry'
              : node.expanded ? 'Collapse' : 'Expand'
          }
        >
          {node.loadStatus === 'loading' ? '…' : node.expanded ? '▾' : '▸'}
        </button>

        {onSelect ? (
          <button className="tax-node-select" onClick={() => onSelect(node)} title={`Start from ${node.name}`}>
            {node.name}
          </button>
        ) : (
          <span className="tax-node-name">{node.name}</span>
        )}
        {/* A failed child fetch (loadStatus:'error') would otherwise look
            just like a real empty/unexpanded node, with no sign the click
            failed. loadStatus stays 'error' (never auto-reset), so the
            chevron above is already clickable again to retry -- this is
            the visual cue that a retry is warranted. */}
        {node.loadStatus === 'error' && (
          <span className="tax-node-load-error" title="Failed to load children — click ▸ to retry">
            ⚠
          </span>
        )}
      </div>

      {node.expanded && node.children.length > 0 && (
        <div className="tax-node-children">
          {node.children.map(child => (
            <HierarchyNodeRow
              key={child.annotationId}
              node={child}
              highlightId={highlightId}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}
