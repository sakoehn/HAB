/**
 * hierarchy-btn.unit.test.tsx
 * =============================
 * Tests for HierarchyBtn (components/hierarchy/HierarchyBtn.tsx) -- the
 * trigger button that opens HierarchyModal. Modeled on ScaffoldBtn, with
 * one addition specific to this button: it must render nothing at all for
 * source === 'taxonomy' (taxonomy already has its own dedicated tree UI)
 * or 'kegg' (KEGG orthologs are a flat list),
 * so call sites (EgcChart, MultiEgcChart, ExplorePage tables) don't need
 * their own per-site conditional.
 *
 * Mocks global fetch since clicking the button mounts HierarchyModal, which
 * immediately fetches /api/{source}/path and /api/{source}/children.
 *
 * Run: npx vitest run src/tests/hierarchy-btn.unit.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { HierarchyBtn } from '../components/hierarchy/HierarchyBtn'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockReturnValue(new Promise(() => {})) // never resolves by default
})

describe('HierarchyBtn — source gating', () => {
  it('renders nothing for source === "taxonomy"', () => {
    const { container } = render(
      <HierarchyBtn annotationId="Bacteria;Proteobacteria" source="taxonomy" />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  // KEGG orthologs are a flat list -- there is no tree to show.
  it('renders nothing for source === "kegg"', () => {
    const { container } = render(<HierarchyBtn annotationId="K00844" source="kegg" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the button for source === "cog"', () => {
    render(<HierarchyBtn annotationId="COG0001" source="cog" />)
    expect(screen.getByTestId('hierarchy-btn')).toBeInTheDocument()
  })

  it('renders the button for source === "enzyme"', () => {
    render(<HierarchyBtn annotationId="1.1.1.1" source="enzyme" />)
    expect(screen.getByTestId('hierarchy-btn')).toBeInTheDocument()
  })
})

describe('HierarchyBtn — open/close', () => {
  it('clicking the button opens the modal', async () => {
    const user = userEvent.setup()
    render(<HierarchyBtn annotationId="COG0001" source="cog" />)

    await user.click(screen.getByTestId('hierarchy-btn'))
    expect(screen.getByTestId('hierarchy-modal')).toBeInTheDocument()
  })

  it('clicking Close removes the modal', async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValue(jsonResponse({
      annotation_id: 'COG0001',
      paths: [[{ annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1 },
               { annotation_id: 'COG0001', name: 'Glutamate-1-semialdehyde aminotransferase', depth: 2 }]],
      path_count: 1,
    }))
    render(<HierarchyBtn annotationId="COG0001" source="cog" />)

    await user.click(screen.getByTestId('hierarchy-btn'))
    expect(screen.getByTestId('hierarchy-modal')).toBeInTheDocument()

    await user.click(screen.getByTestId('close-btn'))
    expect(screen.queryByTestId('hierarchy-modal')).not.toBeInTheDocument()
  })
})
