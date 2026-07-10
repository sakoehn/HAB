// ── useTaxonomyTree ───────────────────────────────────────────────────────────
// Shared lazy-loading tree state for the Taxonomy Explorer. Fetches direct
// children of a taxon via GET /taxonomy/children on demand, caching them in
// local state so re-expanding a node doesn't refetch.
//
// rootId === null means "start at the 4 domain roots" (mirrors the backend's
// parent-omitted convention).
//
// Shared by TaxonomyTree (exclusion picker, re-roots at the chosen scope) and
// TaxonomyBrowseTree (scope picker, always rooted at the domains) so the
// fetch/expand mechanics live in one place while each renders rows differently
// (checkboxes vs. click-to-select).

import { useCallback, useEffect, useState } from 'react'

import type { TaxonomyChildNode, TaxonomyTreeNode } from '../types'
import { apiFetch } from '../utils/api'

function makeNode(child: TaxonomyChildNode): TaxonomyTreeNode {
  return {
    annotationId:   child.annotation_id,
    depth:          child.depth,
    category:       child.category,
    expanded:       false,
    loadStatus:     'idle',
    childrenLoaded: false,
    children:       [],
  }
}

// Immutably apply `patch` to the node matching `id` anywhere in the tree.
function updateNode(
  nodes: TaxonomyTreeNode[],
  id: string,
  patch: Partial<TaxonomyTreeNode>,
): TaxonomyTreeNode[] {
  return nodes.map(n => {
    if (n.annotationId === id) return { ...n, ...patch }
    if (n.children.length > 0) return { ...n, children: updateNode(n.children, id, patch) }
    return n
  })
}

export function useTaxonomyTree(rootId: string | null) {
  const [nodes, setNodes]   = useState<TaxonomyTreeNode[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')

  const fetchChildren = useCallback(async (parent: string | null): Promise<TaxonomyTreeNode[]> => {
    const qs   = parent ? `?parent=${encodeURIComponent(parent)}` : ''
    const json = await apiFetch<{ data: TaxonomyChildNode[] }>(`/api/taxonomy/children${qs}`)
    return (json.data ?? []).map(makeNode)
  }, [])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setNodes([])
    fetchChildren(rootId)
      .then(children => {
        if (cancelled) return
        setNodes(children)
        setStatus('ok')
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [rootId, fetchChildren])

  // canExpand lets a caller veto drilling into a node (the exclusion tree
  // disables expansion below an already-excluded node); defaults to always-on
  // for callers that don't need a guard (e.g. the browse tree).
  const toggleExpand = useCallback(async (
    node: TaxonomyTreeNode,
    canExpand: (node: TaxonomyTreeNode) => boolean = () => true,
  ) => {
    if (!canExpand(node)) return

    if (!node.childrenLoaded) {
      setNodes(prev => updateNode(prev, node.annotationId, { loadStatus: 'loading' }))
      try {
        const children = await fetchChildren(node.annotationId)
        setNodes(prev => updateNode(prev, node.annotationId, {
          children, childrenLoaded: true, loadStatus: 'ok', expanded: true,
        }))
      } catch {
        setNodes(prev => updateNode(prev, node.annotationId, { loadStatus: 'error' }))
      }
      return
    }
    setNodes(prev => updateNode(prev, node.annotationId, { expanded: !node.expanded }))
  }, [fetchChildren])

  return { nodes, status, toggleExpand }
}
