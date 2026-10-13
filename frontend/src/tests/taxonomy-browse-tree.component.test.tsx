/**
 * taxonomy-browse-tree.component.test.tsx
 * =========================================
 * Component tests for TaxonomyBrowseTree
 * (components/taxonomy/TaxonomyBrowseTree.tsx), the scope-picker tree used
 * as an alternative to the search box. Previously had zero tests of any kind.
 *
 * Coverage
 * --------
 *   loading / error states
 *   renders domain-level node names and rank labels
 *   clicking a name button calls onSelectRoot with that node's id
 *   clicking the chevron fetches and renders children
 *   no exclusion checkbox is rendered (unlike TaxonomyTree)
 *
 * Run: npx vitest run src/tests/taxonomy-browse-tree.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TaxonomyBrowseTree } from '../components/taxonomy/TaxonomyBrowseTree'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

function errorResponse(status = 500, statusText = 'Server Error') {
  return { ok: false, status, statusText, json: async () => ({}) }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('TaxonomyBrowseTree — states', () => {
  it('shows a loading message before the fetch resolves', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<TaxonomyBrowseTree onSelectRoot={vi.fn()} />)
    expect(screen.getByText('Loading taxa…')).toBeInTheDocument()
  })

  it('shows an error message when the fetch fails', async () => {
    mockFetch.mockResolvedValue(errorResponse(500))
    render(<TaxonomyBrowseTree onSelectRoot={vi.fn()} />)
    expect(await screen.findByText('Failed to load taxonomy tree.')).toBeInTheDocument()
  })
})

describe('TaxonomyBrowseTree — rendering', () => {
  it('renders the domain-level nodes with rank labels', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [
        { annotation_id: 'Bacteria', name: 'Bacteria', depth: 1, category: 'Bacteria' },
        { annotation_id: 'Archaea',  name: 'Archaea',  depth: 1, category: 'Archaea' },
      ],
    }))
    render(<TaxonomyBrowseTree onSelectRoot={vi.fn()} />)

    expect(await screen.findByText('Bacteria')).toBeInTheDocument()
    expect(screen.getByText('Archaea')).toBeInTheDocument()
    expect(screen.getAllByText('Domain')).toHaveLength(2)
  })

  it('does not render an exclusion checkbox (unlike TaxonomyTree)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Bacteria', name: 'Bacteria', depth: 1, category: 'Bacteria' }],
    }))
    render(<TaxonomyBrowseTree onSelectRoot={vi.fn()} />)
    await screen.findByText('Bacteria')

    expect(document.querySelector('.tax-node-checkbox')).not.toBeInTheDocument()
  })
})

describe('TaxonomyBrowseTree — interaction', () => {
  it('clicking a node name calls onSelectRoot with its id', async () => {
    const user = userEvent.setup()
    const onSelectRoot = vi.fn()
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Bacteria', name: 'Bacteria', depth: 1, category: 'Bacteria' }],
    }))
    render(<TaxonomyBrowseTree onSelectRoot={onSelectRoot} />)
    await screen.findByText('Bacteria')

    await user.click(screen.getByTitle('Use Bacteria as the scope'))
    expect(onSelectRoot).toHaveBeenCalledWith('Bacteria')
  })

  it('clicking the chevron fetches and renders children', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ annotation_id: 'Bacteria', name: 'Bacteria', depth: 1, category: 'Bacteria' }],
    }))
    render(<TaxonomyBrowseTree onSelectRoot={vi.fn()} />)
    await screen.findByText('Bacteria')

    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ annotation_id: 'Proteobacteria', name: 'Proteobacteria', depth: 2, category: null }],
    }))
    await user.click(screen.getByTitle('Expand'))

    expect(await screen.findByText('Proteobacteria')).toBeInTheDocument()
  })

  // G8/G12 (docs/AUDIT-2026-10-05.md): a failed CHILD fetch (as opposed
  // to the root-level failure the "states" describe above already
  // covers) reverted the row to the exact same look as a never-clicked
  // collapsed row, with nothing on screen distinguishing "failed" from
  // "not yet clicked" -- even though the chevron is already clickable
  // again to retry (loadStatus never auto-resets).
  it('shows a warning marker on a node whose child fetch failed, not just a reverted chevron', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ annotation_id: 'Bacteria', name: 'Bacteria', depth: 1, category: 'Bacteria' }],
    }))
    render(<TaxonomyBrowseTree onSelectRoot={vi.fn()} />)
    await screen.findByText('Bacteria')

    mockFetch.mockResolvedValueOnce(errorResponse(500))
    await user.click(screen.getByTitle('Expand'))

    expect(await screen.findByTitle('Failed to load children — click ▸ to retry')).toBeInTheDocument()
  })
})
