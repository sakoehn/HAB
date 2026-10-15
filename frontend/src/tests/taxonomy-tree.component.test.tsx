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
import { render, screen } from '@testing-library/react'
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
      data: [{ annotation_id: 'Proteobacteria', name: 'Proteobacteria', depth: 2, category: 'Bacteria' }],
    }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={vi.fn()} />)

    expect(await screen.findByText('Proteobacteria')).toBeInTheDocument()
    expect(screen.getByText('Phylum')).toBeInTheDocument()
  })

  it('W7: Eukaryota uses the same rank ladder as every other domain', async () => {
    // Confirmed live (2026-09-22 re-audit) via /taxonomy/children: depth 2
    // under Eukaryota is real phyla (Annelida, Arthropoda, Chordata, ...),
    // and a full lineage like Eukaryota;Annelida;...;Helobdella robusta has
    // exactly 8 segments -- the same Domain..Strain ladder Bacteria uses.
    // Depth 2 must be labelled "Phylum" here, not a generic "Level 2".
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Chordata', name: 'Chordata', depth: 2, category: 'Eukaryota' }],
    }))
    render(<TaxonomyTree rootId="Eukaryota" excludedIds={new Set()} onToggleExclude={vi.fn()} />)

    expect(await screen.findByText('Phylum')).toBeInTheDocument()
    expect(screen.queryByText('Level 2')).not.toBeInTheDocument()
  })
})

describe('TaxonomyTree — expand/collapse', () => {
  it('clicking the chevron fetches and renders children', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ annotation_id: 'Proteobacteria', name: 'Proteobacteria', depth: 2, category: null }],
    }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={vi.fn()} />)
    await screen.findByText('Proteobacteria')

    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ annotation_id: 'Alphaproteobacteria', name: 'Alphaproteobacteria', depth: 3, category: null }],
    }))
    await user.click(screen.getByTitle('Expand'))

    expect(await screen.findByText('Alphaproteobacteria')).toBeInTheDocument()
  })

  // G8/G12 (docs/AUDIT-2026-10-05.md): a failed CHILD fetch (as opposed
  // to the root-level failure the "states" describe above already
  // covers) reverted the row to the exact same look as a never-clicked
  // collapsed row -- clicking the chevron again does retry (loadStatus
  // never auto-resets), but nothing on screen told the user the previous
  // click had actually failed.
  it('shows a warning marker on a node whose child fetch failed, not just a reverted chevron', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ annotation_id: 'Proteobacteria', name: 'Proteobacteria', depth: 2, category: null }],
    }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={vi.fn()} />)
    await screen.findByText('Proteobacteria')

    mockFetch.mockResolvedValueOnce(errorResponse(500))
    await user.click(screen.getByTitle('Expand'))

    expect(await screen.findByTitle('Failed to load children — click ▸ to retry')).toBeInTheDocument()
  })
})

describe('TaxonomyTree — exclusion', () => {
  it('clicking the checkbox calls onToggleExclude with the node id', async () => {
    const user = userEvent.setup()
    const onToggleExclude = vi.fn()
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Proteobacteria', name: 'Proteobacteria', depth: 2, category: null }],
    }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set()} onToggleExclude={onToggleExclude} />)
    await screen.findByText('Proteobacteria')

    await user.click(screen.getByTitle('Exclude this taxon (and everything under it) from the total'))
    expect(onToggleExclude).toHaveBeenCalledWith('Proteobacteria')
  })

  it('an excluded node cannot be expanded (chevron disabled)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Proteobacteria', name: 'Proteobacteria', depth: 2, category: null }],
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

  it('W19: a descendant of an already-excluded ancestor has its checkbox disabled', async () => {
    // Simulates the real gap the chevron-disable alone doesn't cover: this
    // child was already visible/loaded from before its ancestor
    // ("Bacteria;Proteobacteria") got excluded, so nothing else stops the
    // user from also checking it -- which would double-subtract it.
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{
        annotation_id: 'Bacteria;Proteobacteria;Alphaproteobacteria',
        name: 'Alphaproteobacteria', depth: 3, category: 'Bacteria',
      }],
    }))
    render(
      <TaxonomyTree
        rootId="Bacteria;Proteobacteria"
        excludedIds={new Set(['Bacteria;Proteobacteria'])}
        onToggleExclude={vi.fn()}
      />,
    )
    await screen.findByText('Alphaproteobacteria')

    expect(screen.getByTitle(
      'Already excluded via an ancestor taxon -- excluding it separately would subtract it twice',
    )).toBeDisabled()
  })

  it('W19: a sibling of an excluded taxon (not a descendant) keeps its checkbox enabled', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ annotation_id: 'Bacteria;Firmicutes', name: 'Firmicutes', depth: 2, category: 'Bacteria' }],
    }))
    render(
      <TaxonomyTree
        rootId="Bacteria"
        excludedIds={new Set(['Bacteria;Proteobacteria'])}
        onToggleExclude={vi.fn()}
      />,
    )
    await screen.findByText('Firmicutes')

    expect(screen.getByTitle('Exclude this taxon (and everything under it) from the total')).not.toBeDisabled()
  })
})

// UI round 2026-10-14: in "Keep only checked" mode a checked branch is kept,
// not removed -- it must not look struck-through/red like an exclusion.
describe('TaxonomyTree — keep-mode styling', () => {
  const CHILD = { annotation_id: 'Proteobacteria', name: 'Proteobacteria', depth: 2, category: 'Bacteria' }

  it('remove mode (default): a checked branch reads as excluded', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [CHILD] }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set(['Proteobacteria'])} onToggleExclude={vi.fn()} />)
    const row = (await screen.findByText('Proteobacteria')).closest('.tax-node-row')!
    expect(row.className).toContain('tax-node-excluded')
  })

  it('keep mode: a checked branch reads as kept, with keep wording', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [CHILD] }))
    render(<TaxonomyTree rootId="Bacteria" excludedIds={new Set(['Proteobacteria'])} onToggleExclude={vi.fn()} mode="keep" />)
    const row = (await screen.findByText('Proteobacteria')).closest('.tax-node-row')!
    expect(row.className).not.toContain('tax-node-excluded')
    expect(row.className).toContain('tax-node-kept')
    const box = row.querySelector('.tax-node-checkbox')!
    expect(box.className).toContain('tax-node-checkbox-keep')
    expect(box.getAttribute('title')).toMatch(/stop keeping/i)
  })
})
