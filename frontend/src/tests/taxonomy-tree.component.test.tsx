/**
 * taxonomy-tree.component.test.tsx
 * ==================================
 * Component tests for TaxonomyTree (components/taxonomy/TaxonomyTree.tsx),
 * the exclusion picker used on the Analyze page's taxonomy scope panel.
 * Previously had zero tests of any kind.
 *
 * Coverage
 * --------
 *   loading / error / empty states
 *   renders a node's name and rank label
 *   expanding a node fetches and renders its children
 *   checkbox click calls onToggleExclude with the node's id
 *   an excluded node is visually marked and cannot be expanded (canExpand veto)
 *
 * Run: npx vitest run src/tests/taxonomy-tree.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TaxonomyTree } from '../components/taxonomy/TaxonomyTree'

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

describe('TaxonomyTree — states', () => {
  it('shows a loading message before the fetch resolves', () => {
    mockFetch.mockReturnValue(new Promise(() => {})) // never resolves
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={vi.fn()} />)
    expect(screen.getByText('Loading taxa…')).toBeInTheDocument()
  })

  it('shows an error message when the fetch fails', async () => {
    mockFetch.mockResolvedValue(errorResponse(500))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={vi.fn()} />)
    expect(await screen.findByText('Failed to load taxonomy tree.')).toBeInTheDocument()
  })

  it('shows an empty-scope message when there are no children', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={vi.fn()} />)
    expect(await screen.findByText('No child taxa under this scope.')).toBeInTheDocument()
  })
})

describe('TaxonomyTree — rendering', () => {
  it('renders a node name and its prokaryote rank label', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Proteobacteria', depth: 2, category: 'Bacteria' }],
    }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={vi.fn()} />)

    expect(await screen.findByText('Proteobacteria')).toBeInTheDocument()
    expect(screen.getByText('Phylum')).toBeInTheDocument()
  })

  it('falls back to "Level N" rank label for Eukaryota', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Chordata', depth: 2, category: 'Eukaryota' }],
    }))
    render(<TaxonomyTree rootId="Eukaryota" excludedIds={new Set()} onToggleExclude={vi.fn()} />)

    expect(await screen.findByText('Level 2')).toBeInTheDocument()
  })
})

describe('TaxonomyTree — expand/collapse', () => {
  it('clicking the chevron fetches and renders children', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ annotation_id: 'Proteobacteria', depth: 2, category: null }],
    }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={vi.fn()} />)
    await screen.findByText('Proteobacteria')

    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ annotation_id: 'Alphaproteobacteria', depth: 3, category: null }],
    }))
    await user.click(screen.getByTitle('Expand'))

    expect(await screen.findByText('Alphaproteobacteria')).toBeInTheDocument()
  })
})

describe('TaxonomyTree — exclusion', () => {
  it('clicking the checkbox calls onToggleExclude with the node id', async () => {
    const user = userEvent.setup()
    const onToggleExclude = vi.fn()
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Proteobacteria', depth: 2, category: null }],
    }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={onToggleExclude} />)
    await screen.findByText('Proteobacteria')

    await user.click(screen.getByTitle('Exclude this taxon (and everything under it) from the total'))
    expect(onToggleExclude).toHaveBeenCalledWith('Proteobacteria')
  })

  it('an excluded node cannot be expanded (chevron disabled)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Proteobacteria', depth: 2, category: null }],
    }))
    render(
      <TaxonomyTree
        rootId="Bacteria"
        excludedIds={new Set(['Proteobacteria'])}
        onToggleExclude={vi.fn()}
      />,
    )
    await screen.findByText('Proteobacteria')

    expect(screen.getByTitle('Cannot drill into an excluded taxon')).toBeDisabled()
  })
})
