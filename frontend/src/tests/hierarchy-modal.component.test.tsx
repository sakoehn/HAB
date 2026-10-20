/**
 * hierarchy-modal.component.test.tsx
 * =====================================
 * Integration test for HierarchyModal + useHierarchyTree's expandToPath/
 * switchToPath -- the actual feature this whole popup exists for: opening
 * it for one specific annotation must auto-expand the tree down to that
 * annotation and highlight it (not an empty root), and when that
 * annotation has multiple real parents, a picker must let the user switch
 * between them.
 *
 * Uses the real K00844/hexokinase example: a KEGG node with 14 real
 * pathway parents. GET /kegg/path must resolve
 * (by default) to the Metabolism > Carbohydrate metabolism > Glycolysis
 * chain, and switching the picker to "Fructose and mannose metabolism"
 * must move the tree's expanded/highlighted branch to match.
 *
 * Run: npx vitest run src/tests/hierarchy-modal.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { HierarchyModal } from '../components/hierarchy/HierarchyModal'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

// Two of K00844's 14 real paths (both real, from tests/sql/test_cache_sql.py's
// direct-query verification) -- enough to exercise switching without
// hardcoding all 14.
const GLYCOLYSIS_PATH = [
  { annotation_id: '09100', name: 'Metabolism', depth: 1 },
  { annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2 },
  { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 3 },
  { annotation_id: 'K00844', name: 'HK; hexokinase', depth: 4 },
]
const FRUCTOSE_PATH = [
  { annotation_id: '09100', name: 'Metabolism', depth: 1 },
  { annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2 },
  { annotation_id: '00051', name: 'Fructose and mannose metabolism', depth: 3 },
  { annotation_id: 'K00844', name: 'HK; hexokinase', depth: 4 },
]

const PATH_RESPONSE = {
  annotation_id: 'K00844',
  paths:         [GLYCOLYSIS_PATH, FRUCTOSE_PATH],
  path_count:    14,
}

const CHILDREN_BY_PARENT: Record<string, unknown[]> = {
  root:    [{ annotation_id: '09100', name: 'Metabolism', depth: 1, category: 'Metabolism' }],
  '09100': [{ annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2, category: 'Metabolism' }],
  // Both real pathways are siblings under Carbohydrate metabolism.
  '09101': [
    { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 3, category: 'Metabolism' },
    { annotation_id: '00051', name: 'Fructose and mannose metabolism', depth: 3, category: 'Metabolism' },
  ],
  '00010': [{ annotation_id: 'K00844', name: 'HK; hexokinase', depth: 4, category: 'Metabolism' }],
  '00051': [{ annotation_id: 'K00844', name: 'HK; hexokinase', depth: 4, category: 'Metabolism' }],
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/kegg/path')) return Promise.resolve(jsonResponse(PATH_RESPONSE))
    const match = /parent=([^&]*)/.exec(url)
    const parent = match ? decodeURIComponent(match[1]) : 'root'
    return Promise.resolve(jsonResponse({ data: CHILDREN_BY_PARENT[parent] ?? [] }))
  })
})

describe('HierarchyModal — auto-expand to path', () => {
  it('expands every ancestor down to the target annotation (first/primary path)', async () => {
    render(<HierarchyModal annotationId="K00844" source="kegg" onClose={vi.fn()} />)

    expect(await screen.findByText('Metabolism')).toBeInTheDocument()
    expect(await screen.findByText('Carbohydrate metabolism')).toBeInTheDocument()
    expect(await screen.findByText('Glycolysis / Gluconeogenesis')).toBeInTheDocument()
    expect(await screen.findByText('HK; hexokinase')).toBeInTheDocument()
  })

  it('highlights the target annotation once expansion completes', async () => {
    render(<HierarchyModal annotationId="K00844" source="kegg" onClose={vi.fn()} />)

    const leafRow = await screen.findByText('HK; hexokinase')
    expect(leafRow.closest('.tax-node-row')).toHaveClass('hier-node-highlighted')
  })

  it('shows a path picker with a count when path_count > 1', async () => {
    render(<HierarchyModal annotationId="K00844" source="kegg" onClose={vi.fn()} />)
    expect(await screen.findByTestId('multi-parent-note')).toHaveTextContent('14 real KEGG pathways')
    expect(screen.getByTestId('path-picker')).toBeInTheDocument()
  })

  // The note must name the source's own kind of parent -- a real
  // multi-category COG like COG0028 (category E and H) has categories, not
  // "KEGG pathways".
  it('names the real source-specific noun, not "KEGG pathways", for a multi-category COG', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/cog/path')) {
        return Promise.resolve(jsonResponse({
          annotation_id: 'COG0028',
          path_count:    2,
          paths: [
            [
              { annotation_id: 'E', name: 'Amino acid transport and metabolism', depth: 1 },
              { annotation_id: 'COG0028', name: 'Thiamine-related protein', depth: 2 },
            ],
            [
              { annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1 },
              { annotation_id: 'COG0028', name: 'Thiamine-related protein', depth: 2 },
            ],
          ],
        }))
      }
      return Promise.resolve(jsonResponse({ data: [] }))
    })
    render(<HierarchyModal annotationId="COG0028" source="cog" onClose={vi.fn()} />)

    const note = await screen.findByTestId('multi-parent-note')
    expect(note).toHaveTextContent('2 real COG categories')
    expect(note).not.toHaveTextContent('KEGG')
  })

  it('does not show the path picker for a single-parent node', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/cog/path')) {
        return Promise.resolve(jsonResponse({
          annotation_id: 'COG0001',
          paths: [[
            { annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1 },
            { annotation_id: 'COG0001', name: 'Glutamate-1-semialdehyde aminotransferase', depth: 2 },
          ]],
          path_count: 1,
        }))
      }
      const match = /parent=([^&]*)/.exec(url)
      const parent = match ? decodeURIComponent(match[1]) : 'root'
      const data = parent === 'root'
        ? [{ annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1, category: 'Coenzyme transport and metabolism' }]
        : [{ annotation_id: 'COG0001', name: 'Glutamate-1-semialdehyde aminotransferase', depth: 2, category: 'Coenzyme transport and metabolism' }]
      return Promise.resolve(jsonResponse({ data }))
    })

    render(<HierarchyModal annotationId="COG0001" source="cog" onClose={vi.fn()} />)
    await screen.findByText('Glutamate-1-semialdehyde aminotransferase')
    expect(screen.queryByTestId('multi-parent-note')).not.toBeInTheDocument()
    expect(screen.queryByTestId('path-picker')).not.toBeInTheDocument()
  })

  it('shows an error state when the annotation cannot be located', async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }))
    render(<HierarchyModal annotationId="NOT_REAL" source="kegg" onClose={vi.fn()} />)
    expect(await screen.findByTestId('error-state')).toBeInTheDocument()
  })

  // /kegg/path (the fetch pathStatus
  // tracks) is a SEPARATE request from the root /kegg/children fetch
  // goToPath triggers internally to resolve the ancestor chain -- the
  // path lookup itself can succeed (pathStatus 'ok') while that root
  // fetch independently fails, leaving `nodes` empty. That must not render
  // the same "No entries under this node." message as a genuinely
  // childless root.
  it('shows a distinct tree-load error when the root fetch fails even though the path lookup succeeded', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/kegg/path')) {
        return Promise.resolve(jsonResponse({
          annotation_id: 'K00844',
          paths: [GLYCOLYSIS_PATH],
          path_count: 1,
        }))
      }
      // The bare root fetch has no `?parent=` at all -- only that one
      // request fails; this still proves it's reachable from a fully
      // successful path lookup, not an artificial fetch-everything stub.
      if (!url.includes('parent=')) {
        return Promise.reject(new Error('network error'))
      }
      return Promise.resolve(jsonResponse({ data: [] }))
    })

    render(<HierarchyModal annotationId="K00844" source="kegg" onClose={vi.fn()} />)

    expect(await screen.findByText('Failed to load hierarchy tree.')).toBeInTheDocument()
    expect(screen.queryByText('No entries under this node.')).not.toBeInTheDocument()
  })
})

describe('HierarchyModal — switching between real paths', () => {
  it('switching the picker moves the expanded/highlighted branch to the new path', async () => {
    const user = userEvent.setup()
    render(<HierarchyModal annotationId="K00844" source="kegg" onClose={vi.fn()} />)

    // Starts on the primary (Glycolysis) path.
    await screen.findByText('Glycolysis / Gluconeogenesis')
    expect(screen.getByText('HK; hexokinase').closest('.tax-node-row')).toHaveClass('hier-node-highlighted')

    await user.selectOptions(screen.getByTestId('path-picker'), '1')

    // The shared ancestor stays put; the leaf now sits under Fructose
    // instead, and is still the one highlighted.
    expect(await screen.findByText('Fructose and mannose metabolism')).toBeInTheDocument()
    expect(screen.getByText('Carbohydrate metabolism')).toBeInTheDocument()
    const leafRow = screen.getByText('HK; hexokinase').closest('.tax-node-row')
    expect(leafRow).toHaveClass('hier-node-highlighted')
  })

  it('lists every real path as a picker option, labelled by its distinguishing pathway', async () => {
    render(<HierarchyModal annotationId="K00844" source="kegg" onClose={vi.fn()} />)
    await screen.findByTestId('path-picker')

    expect(screen.getByRole('option', { name: /Glycolysis \/ Gluconeogenesis/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Fructose and mannose metabolism/ })).toBeInTheDocument()
  })
})
