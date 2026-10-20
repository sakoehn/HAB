// ── TaxonomyBrowseTree ────────────────────────────────────────────────────────
// Expandable tree for picking a scope taxon by browsing, as an alternative to
// the search box — always rooted at the 4 domains (Bacteria, Archaea,
// Eukaryota, Viruses) and lets the user drill down and click any taxon at any
// depth to use it as the scope. Shares its lazy-load/expand mechanics with
// TaxonomyTree via useTaxonomyTree; unlike that tree, rows have no checkbox —
// clicking a name selects it directly.

import type { TaxonomyTreeNode } from '../../types'
import { taxonomyRankLabel } from '../../constants'
import { useTaxonomyTree } from '../../hooks/useTaxonomyTree'
import { SkeletonTreeRows } from '../ui/Skeleton'

export function TaxonomyBrowseTree({
  onSelectRoot,
}: {
  onSelectRoot: (annotationId: string) => void
}) {
  const { nodes, status, toggleExpand } = useTaxonomyTree(null)

  if (status === 'loading' && nodes.length === 0) {
    return (
      <>
        <span className="sr-only">Loading taxa…</span>
        <SkeletonTreeRows rows={4} />
      </>
    )
  }
  if (status === 'error') {
    return <div className="tax-tree-status tax-tree-error">Failed to load taxonomy tree.</div>
  }

  return (
    <div className="tax-tree">
      {nodes.map(node => (
        <BrowseNodeRow
          key={node.annotationId}
          node={node}
          onSelectRoot={onSelectRoot}
          onToggleExpand={n => toggleExpand(n)}
        />
      ))}
    </div>
  )
}

function BrowseNodeRow({
  node,
  onSelectRoot,
  onToggleExpand,
}: {
  node:           TaxonomyTreeNode
  onSelectRoot:   (annotationId: string) => void
  onToggleExpand: (node: TaxonomyTreeNode) => void
}) {
  const rank = taxonomyRankLabel(node.depth, node.category)

  return (
    <div className="tax-node">
      <div className="tax-node-row">
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

        {/* See HierarchyTree's matching comment -- without this, a
            failed child fetch (loadStatus:'error') would look identical to
            a row that was simply never clicked. */}
        {node.loadStatus === 'error' && (
          <span className="tax-node-load-error" title="Failed to load children — click ▸ to retry">
            ⚠
          </span>
        )}

        <button
          className="tax-node-select"
          onClick={() => onSelectRoot(node.annotationId)}
          title={`Use ${node.name} as the scope`}
        >
          {node.name}
      </button>


        <span className="tax-node-rank">{rank}</span>
      </div>

      {node.expanded && node.children.length > 0 && (
        <div className="tax-node-children">
          {node.children.map(child => (
            <BrowseNodeRow
              key={child.annotationId}
              node={child}
              onSelectRoot={onSelectRoot}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  )
}
