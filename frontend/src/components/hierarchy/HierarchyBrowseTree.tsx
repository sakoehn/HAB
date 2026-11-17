// ── HierarchyBrowseTree ───────────────────────────────────────────────────────
// COG/Enzyme tree for picking a node by clicking it -- the Bulk
// Download section's "Browse tree" for those sources. Same lazy-loading
// tree as the hierarchy popup (useHierarchyTree + HierarchyTree), rooted at
// the top level, with every name clickable.

import { useEffect } from 'react'

import type { HierarchySource, HierarchyTreeNode } from '../../types'
import { useHierarchyTree } from '../../hooks/useHierarchyTree'
import { HierarchyTree } from './HierarchyTree'
import { SkeletonTreeRows } from '../ui/Skeleton'

export function HierarchyBrowseTree({
  source,
  onSelect,
}: {
  source:   HierarchySource
  onSelect: (node: HierarchyTreeNode) => void
}) {
  const { nodes, status, loadRoot, toggleExpand } = useHierarchyTree(source)

  useEffect(() => {
    loadRoot()
  }, [loadRoot])

  if (status !== 'ok' && status !== 'error') {
    return (
      <>
        <span className="sr-only">Loading tree…</span>
        <SkeletonTreeRows rows={4} />
      </>
    )
  }
  return <HierarchyTree nodes={nodes} status={status} highlightId={null} onToggleExpand={toggleExpand} onSelect={onSelect} />
}
