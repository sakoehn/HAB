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
 * Uses two real examples: EC 2.7.1.1 (hexokinase), four levels deep, for
 * expanding and highlighting; and COG0028, a real member of both category
 * E and category H, for the path picker and switching between paths.
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

// EC 2.7.1.1's real path (enzyme_paths).
const HEXOKINASE_PATH = [
  { annotation_id: '2', name: 'Transferases', depth: 1 },
  { annotation_id: '2.7', name: 'Transferring phosphorus-containing groups', depth: 2 },
  { annotation_id: '2.7.1', name: 'Phosphotransferases with an alcohol group as acceptor', depth: 3 },
  { annotation_id: '2.7.1.1', name: 'hexokinase', depth: 4 },
]
const ENZYME_CHILDREN: Record<string, unknown[]> = {
  root:    [{ annotation_id: '2', name: 'Transferases', depth: 1, category: 'Transferases' }],
  '2':     [{ annotation_id: '2.7', name: 'Transferring phosphorus-containing groups', depth: 2, category: 'Transferases' }],
  '2.7':   [{ annotation_id: '2.7.1', name: 'Phosphotransferases with an alcohol group as acceptor', depth: 3, category: 'Transferases' }],
  '2.7.1': [{ annotation_id: '2.7.1.1', name: 'hexokinase', depth: 4, category: 'Transferases' }],
}

// COG0028's two real paths (cog_paths).
const COG0028_NAME = 'Acetolactate synthase large subunit or other thiamine pyrophosphate-requiring enzyme'
const E_PATH = [
  { annotation_id: 'E', name: 'Amino acid transport and metabolism', depth: 1 },
  { annotation_id: 'COG0028', name: COG0028_NAME, depth: 2 },
]
const H_PATH = [
  { annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1 },
  { annotation_id: 'COG0028', name: COG0028_NAME, depth: 2 },
]
const COG_CHILDREN: Record<string, unknown[]> = {
  root: [
    { annotation_id: 'E', name: 'Amino acid transport and metabolism', depth: 1, category: 'Amino acid transport and metabolism' },
    { annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1, category: 'Coenzyme transport and metabolism' },
  ],
  E: [{ annotation_id: 'COG0028', name: COG0028_NAME, depth: 2, category: 'Amino acid transport and metabolism' }],
  H: [{ annotation_id: 'COG0028', name: COG0028_NAME, depth: 2, category: 'Coenzyme transport and metabolism' }],
}

function childrenResponse(url: string, table: Record<string, unknown[]>) {
  const match = /parent=([^&]*)/.exec(url)
  const parent = match ? decodeURIComponent(match[1]) : 'root'
  return Promise.resolve(jsonResponse({ data: table[parent] ?? [] }))
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/enzyme/path')) {
      return Promise.resolve(jsonResponse({ annotation_id: '2.7.1.1', paths: [HEXOKINASE_PATH], path_count: 1 }))
    }
    if (url.includes('/cog/path')) {
      return Promise.resolve(jsonResponse({ annotation_id: 'COG0028', paths: [E_PATH, H_PATH], path_count: 2 }))
    }
    return childrenResponse(url, url.includes('/cog/') ? COG_CHILDREN : ENZYME_CHILDREN)
  })
})

describe('HierarchyModal — auto-expand to path', () => {
  it('expands every ancestor down to the target annotation', async () => {
    render(<HierarchyModal annotationId="2.7.1.1" source="enzyme" onClose={vi.fn()} />)

    expect(await screen.findByText('Transferases')).toBeInTheDocument()
    expect(await screen.findByText('Transferring phosphorus-containing groups')).toBeInTheDocument()
    expect(await screen.findByText('Phosphotransferases with an alcohol group as acceptor')).toBeInTheDocument()
    expect(await screen.findByText('hexokinase')).toBeInTheDocument()
  })

  it('highlights the target annotation once expansion completes', async () => {
    render(<HierarchyModal annotationId="2.7.1.1" source="enzyme" onClose={vi.fn()} />)

    const leafRow = await screen.findByText('hexokinase')
    expect(leafRow.closest('.tax-node-row')).toHaveClass('hier-node-highlighted')
  })

  it('shows a path picker with a count when path_count > 1', async () => {
    render(<HierarchyModal annotationId="COG0028" source="cog" onClose={vi.fn()} />)
    expect(await screen.findByTestId('multi-parent-note')).toHaveTextContent('2 real COG categories')
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
    render(<HierarchyModal annotationId="NOT_REAL" source="cog" onClose={vi.fn()} />)
    expect(await screen.findByTestId('error-state')).toBeInTheDocument()
  })

  // /enzyme/path (the fetch pathStatus
  // tracks) is a SEPARATE request from the root /enzyme/children fetch
  // goToPath triggers internally to resolve the ancestor chain -- the
  // path lookup itself can succeed (pathStatus 'ok') while that root
  // fetch independently fails, leaving `nodes` empty. That must not render
  // the same "No entries under this node." message as a genuinely
  // childless root.
  it('shows a distinct tree-load error when the root fetch fails even though the path lookup succeeded', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/enzyme/path')) {
        return Promise.resolve(jsonResponse({
          annotation_id: '2.7.1.1',
          paths: [HEXOKINASE_PATH],
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

    render(<HierarchyModal annotationId="2.7.1.1" source="enzyme" onClose={vi.fn()} />)

    expect(await screen.findByText('Failed to load hierarchy tree.')).toBeInTheDocument()
    expect(screen.queryByText('No entries under this node.')).not.toBeInTheDocument()
  })
})

describe('HierarchyModal — switching between real paths', () => {
  it('switching the picker moves the highlighted leaf to the new path', async () => {
    const user = userEvent.setup()
    render(<HierarchyModal annotationId="COG0028" source="cog" onClose={vi.fn()} />)

    // Starts on the primary (E) path, with the leaf highlighted.
    await screen.findByTestId('path-picker')
    const first = await screen.findByText(COG0028_NAME)
    expect(first.closest('.tax-node-row')).toHaveClass('hier-node-highlighted')

    await user.selectOptions(screen.getByTestId('path-picker'), '1')

    // The leaf now sits under H, and exactly one copy is highlighted.
    const rows = await screen.findAllByText(COG0028_NAME)
    const highlighted = rows.filter(r => r.closest('.tax-node-row')?.classList.contains('hier-node-highlighted'))
    expect(highlighted).toHaveLength(1)
    expect(screen.getByText('Coenzyme transport and metabolism')).toBeInTheDocument()
  })

  it('lists every real path as a picker option, labelled by its distinguishing category', async () => {
    render(<HierarchyModal annotationId="COG0028" source="cog" onClose={vi.fn()} />)
    await screen.findByTestId('path-picker')

    expect(screen.getByRole('option', { name: /Amino acid transport and metabolism/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Coenzyme transport and metabolism/ })).toBeInTheDocument()
  })
})
