/**
 * use-taxonomy-tree.unit.test.ts
 * ===============================
 * Unit tests for useTaxonomyTree (hooks/useTaxonomyTree.ts) — the shared
 * lazy-loading tree state behind both TaxonomyTree and TaxonomyBrowseTree.
 *
 * Coverage
 * --------
 *   initial fetch with rootId=null omits the ?parent= query param
 *   initial fetch with a rootId includes ?parent=<encoded id>
 *   successful fetch populates nodes with idle/unloaded defaults, status=ok
 *   fetch failure sets status=error
 *   changing rootId re-fetches
 *   toggleExpand on an unloaded node fetches its children and expands it
 *   toggleExpand on an already-loaded node just flips expanded, no re-fetch
 *   toggleExpand failure sets that node's loadStatus to error
 *   canExpand veto blocks expansion entirely (no fetch, no state change)
 *   toggleExpand updates the correct node even when nested under a sibling
 *
 * Run: npx vitest run src/tests/use-taxonomy-tree.unit.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

import { useTaxonomyTree } from '../hooks/useTaxonomyTree'
import type { TaxonomyChildNode } from '../types'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

function errorResponse(status = 500, statusText = 'Server Error') {
  return { ok: false, status, statusText, json: async () => ({}) }
}

function child(id: string, depth: number | null = 1, category: string | null = null): TaxonomyChildNode {
  return { annotation_id: id, depth, category }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('useTaxonomyTree — initial load', () => {
  it('fetches without a ?parent= param when rootId is null', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [child('Bacteria')] }))
    const { result } = renderHook(() => useTaxonomyTree(null))

    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(mockFetch).toHaveBeenCalledWith('/api/taxonomy/children', expect.anything())
  })

  it('fetches with an encoded ?parent= param when rootId is set', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }))
    renderHook(() => useTaxonomyTree('Alpha Proteobacteria'))

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/taxonomy/children?parent=Alpha%20Proteobacteria',
      expect.anything(),
    )
  })

  it('populates nodes with idle/unloaded defaults on success', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [child('Bacteria', 1, 'domain')] }))
    const { result } = renderHook(() => useTaxonomyTree(null))

    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.nodes).toEqual([{
      annotationId:   'Bacteria',
      depth:          1,
      category:       'domain',
      expanded:       false,
      loadStatus:     'idle',
      childrenLoaded: false,
      children:       [],
    }])
  })

  it('sets status to error when the fetch fails', async () => {
    mockFetch.mockResolvedValue(errorResponse(500))
    const { result } = renderHook(() => useTaxonomyTree(null))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.nodes).toEqual([])
  })

  it('re-fetches when rootId changes', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }))
    const { result, rerender } = renderHook(
      ({ rootId }) => useTaxonomyTree(rootId),
      { initialProps: { rootId: null as string | null } },
    )
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(mockFetch).toHaveBeenCalledTimes(1)

    rerender({ rootId: 'Bacteria' })
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(mockFetch).toHaveBeenLastCalledWith(
      '/api/taxonomy/children?parent=Bacteria',
      expect.anything(),
    )
  })
})

describe('useTaxonomyTree — toggleExpand', () => {
  async function setupWithOneNode() {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [child('Bacteria', 1, 'domain')] }))
    const { result } = renderHook(() => useTaxonomyTree(null))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    return result
  }

  it('fetches children and expands an unloaded node', async () => {
    const result = await setupWithOneNode()
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [child('Proteobacteria', 2)] }))

    await act(async () => {
      await result.current.toggleExpand(result.current.nodes[0])
    })

    const node = result.current.nodes[0]
    expect(node.childrenLoaded).toBe(true)
    expect(node.loadStatus).toBe('ok')
    expect(node.expanded).toBe(true)
    expect(node.children).toEqual([{
      annotationId:   'Proteobacteria',
      depth:          2,
      category:       null,
      expanded:       false,
      loadStatus:     'idle',
      childrenLoaded: false,
      children:       [],
    }])
    expect(mockFetch).toHaveBeenLastCalledWith(
      '/api/taxonomy/children?parent=Bacteria',
      expect.anything(),
    )
  })

  it('toggling an already-loaded node just flips expanded, without re-fetching', async () => {
    const result = await setupWithOneNode()
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))

    await act(async () => {
      await result.current.toggleExpand(result.current.nodes[0])
    })
    expect(result.current.nodes[0].expanded).toBe(true)
    const callsAfterFirstExpand = mockFetch.mock.calls.length

    await act(async () => {
      await result.current.toggleExpand(result.current.nodes[0])
    })
    expect(result.current.nodes[0].expanded).toBe(false)
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirstExpand)
  })

  it('sets loadStatus to error when expanding fails', async () => {
    const result = await setupWithOneNode()
    mockFetch.mockResolvedValueOnce(errorResponse(500))

    await act(async () => {
      await result.current.toggleExpand(result.current.nodes[0])
    })

    const node = result.current.nodes[0]
    expect(node.loadStatus).toBe('error')
    expect(node.childrenLoaded).toBe(false)
    expect(node.expanded).toBe(false)
  })

  it('canExpand veto blocks expansion entirely — no fetch, no state change', async () => {
    const result = await setupWithOneNode()
    const callsBefore = mockFetch.mock.calls.length

    await act(async () => {
      await result.current.toggleExpand(result.current.nodes[0], () => false)
    })

    expect(mockFetch.mock.calls.length).toBe(callsBefore)
    expect(result.current.nodes[0]).toMatchObject({
      expanded: false, childrenLoaded: false, loadStatus: 'idle',
    })
  })

  it('updates the correct node when it is nested under a sibling', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [child('Bacteria', 1), child('Archaea', 1)],
    }))
    const { result } = renderHook(() => useTaxonomyTree(null))
    await waitFor(() => expect(result.current.status).toBe('ok'))

    // Expand Bacteria first so it has children.
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [child('Proteobacteria', 2)] }))
    await act(async () => {
      const bacteria = result.current.nodes.find(n => n.annotationId === 'Bacteria')!
      await result.current.toggleExpand(bacteria)
    })

    // Now expand the nested Proteobacteria node — must update it in place,
    // leaving the Archaea sibling and the Bacteria parent's own fields intact.
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
    await act(async () => {
      const bacteria = result.current.nodes.find(n => n.annotationId === 'Bacteria')!
      const proteo   = bacteria.children.find(n => n.annotationId === 'Proteobacteria')!
      await result.current.toggleExpand(proteo)
    })

    const bacteria = result.current.nodes.find(n => n.annotationId === 'Bacteria')!
    const archaea  = result.current.nodes.find(n => n.annotationId === 'Archaea')!
    const proteo   = bacteria.children.find(n => n.annotationId === 'Proteobacteria')!
    expect(proteo.expanded).toBe(true)
    expect(proteo.childrenLoaded).toBe(true)
    expect(bacteria.expanded).toBe(true)
    expect(archaea.childrenLoaded).toBe(false)
  })
})
