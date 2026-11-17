// ── useHierarchyTree ─────────────────────────────────────────────────────────
// Lazy-loading tree state for the COG/Enzyme hierarchy popup. Fetches
// direct children of a node via GET /{source}/children on demand, same
// mechanics as useTaxonomyTree.ts (kept as a separate, parallel
// implementation rather than a shared abstraction -- matches this codebase's
// existing house style of per-source functions, e.g. cache_sql.py's
// get_cog_children_sql/get_enzyme_children_sql).
//
// Always rooted at the top level (no re-rootable "scope" concept the way
// TaxonomyTree has) -- the popup always opens showing the whole source tree.
//
// Adds expandToPath(): fetches GET /{source}/path?id=X, which returns EVERY
// real ancestor chain for a node (a COG can be in several categories --
// e.g. COG0028 is under E and H), and expands the first (file-
// order-primary) one, highlighting the leaf. switchToPath() lets the caller
// (the popup's path picker) switch to a different real chain afterward --
// it collapses whichever ancestors aren't shared with the new chain and
// expands the new chain's ancestors, reusing already-loaded/cached levels
// (e.g. a shared ancestor of both chains is never re-fetched
// or even collapsed).

import { useCallback, useRef, useState } from 'react'

import type { HierarchyChildNode, HierarchyPathNode, HierarchyPathResponse, HierarchySource, HierarchyTreeNode } from '../types'
import { apiFetch } from '../utils/api'

function makeNode(child: HierarchyChildNode): HierarchyTreeNode {
  return {
    annotationId:   child.annotation_id,
    name:           child.name,
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
  nodes: HierarchyTreeNode[],
  id: string,
  patch: Partial<HierarchyTreeNode>,
): HierarchyTreeNode[] {
  return nodes.map(n => {
    if (n.annotationId === id) return { ...n, ...patch }
    if (n.children.length > 0) return { ...n, children: updateNode(n.children, id, patch) }
    return n
  })
}

// Find a node anywhere in the tree by id (used to check childrenLoaded
// state before deciding whether expandToPath needs to fetch a level).
function findNode(nodes: HierarchyTreeNode[], id: string): HierarchyTreeNode | null {
  for (const n of nodes) {
    if (n.annotationId === id) return n
    if (n.children.length > 0) {
      const found = findNode(n.children, id)
      if (found) return found
    }
  }
  return null
}

export function useHierarchyTree(source: HierarchySource) {
  const [nodes, setNodes]             = useState<HierarchyTreeNode[]>([])
  const [status, setStatus]           = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [paths, setPaths]             = useState<HierarchyPathNode[][]>([])
  const [selectedPathIndex, setSelectedPathIndex] = useState(0)

  // Ancestor ids (excluding the leaf) currently expanded to reach
  // highlightId -- internal bookkeeping only, doesn't need to be reactive.
  const currentAncestorsRef = useRef<string[]>([])

  const fetchChildren = useCallback(async (parent: string | null): Promise<HierarchyTreeNode[]> => {
    const qs   = parent ? `?parent=${encodeURIComponent(parent)}` : ''
    const json = await apiFetch<{ data: HierarchyChildNode[] }>(`/api/${source}/children${qs}`)
    return (json.data ?? []).map(makeNode)
  }, [source])

  const loadRoot = useCallback(async () => {
    setStatus('loading')
    setNodes([])
    try {
      const children = await fetchChildren(null)
      setNodes(children)
      setStatus('ok')
      return children
    } catch {
      setStatus('error')
      return null
    }
  }, [fetchChildren])

  // Ensures a node's children are loaded and it is expanded -- unlike
  // toggleExpand, never collapses an already-expanded node. Returns the
  // node's (now-loaded) children so callers can look up the next level
  // without a second render round-trip.
  const ensureExpanded = useCallback(async (
    currentNodes: HierarchyTreeNode[],
    annotationId: string,
  ): Promise<HierarchyTreeNode[]> => {
    const existing = findNode(currentNodes, annotationId)
    if (existing?.childrenLoaded) {
      if (!existing.expanded) {
        setNodes(prev => updateNode(prev, annotationId, { expanded: true }))
      }
      return existing.children
    }

    setNodes(prev => updateNode(prev, annotationId, { loadStatus: 'loading' }))
    try {
      const children = await fetchChildren(annotationId)
      setNodes(prev => updateNode(prev, annotationId, {
        children, childrenLoaded: true, loadStatus: 'ok', expanded: true,
      }))
      return children
    } catch {
      setNodes(prev => updateNode(prev, annotationId, { loadStatus: 'error' }))
      return []
    }
  }, [fetchChildren])

  const toggleExpand = useCallback(async (node: HierarchyTreeNode) => {
    if (!node.childrenLoaded) {
      await ensureExpanded(nodes, node.annotationId)
      return
    }
    setNodes(prev => updateNode(prev, node.annotationId, { expanded: !node.expanded }))
  }, [nodes, ensureExpanded])

  // Expands one specific real ancestor chain (root pre-loaded if needed),
  // collapsing whichever previously-expanded ancestors aren't part of this
  // chain, then (re-)highlights the leaf. Assumes `paths` is already
  // populated (expandToPath sets it on first open).
  const goToPath = useCallback(async (path: HierarchyPathNode[]) => {
    const leafId       = path[path.length - 1].annotation_id
    const newAncestors = path.slice(0, -1).map(n => n.annotation_id)

    const toCollapse = currentAncestorsRef.current.filter(id => !newAncestors.includes(id))
    if (toCollapse.length > 0) {
      setNodes(prev => toCollapse.reduce((acc, id) => updateNode(acc, id, { expanded: false }), prev))
    }

    let currentLevel = nodes.length > 0 ? nodes : (await loadRoot()) ?? []
    // Sequential, not parallel -- each level's children are only knowable
    // once its parent has actually been fetched.
    for (const ancestorId of newAncestors) {
      currentLevel = await ensureExpanded(currentLevel, ancestorId)
    }

    currentAncestorsRef.current = newAncestors
    setHighlightId(leafId)
  }, [nodes, loadRoot, ensureExpanded])

  // Fetches every real ancestor chain for annotationId and expands the
  // first (file-order-primary) one. Returns { pathCount } on success
  // (pathCount > 1 only for a COG in several categories), or null
  // if the id isn't a real node / the fetch failed.
  const expandToPath = useCallback(async (annotationId: string): Promise<{ pathCount: number } | null> => {
    let pathResponse: HierarchyPathResponse
    try {
      pathResponse = await apiFetch<HierarchyPathResponse>(
        `/api/${source}/path?id=${encodeURIComponent(annotationId)}`,
      )
    } catch {
      return null
    }

    setPaths(pathResponse.paths)
    setSelectedPathIndex(0)
    currentAncestorsRef.current = []
    await goToPath(pathResponse.paths[0])

    return { pathCount: pathResponse.path_count }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  // Switches to a different one of the already-fetched real ancestor
  // chains (the path picker) -- no new network fetch for the path list
  // itself, only for whichever levels along the new chain aren't already
  // cached from a previous chain.
  const switchToPath = useCallback(async (index: number) => {
    if (index < 0 || index >= paths.length) return
    setSelectedPathIndex(index)
    await goToPath(paths[index])
  }, [paths, goToPath])

  return {
    nodes, status, highlightId, paths, selectedPathIndex,
    loadRoot, toggleExpand, expandToPath, switchToPath,
  }
}
