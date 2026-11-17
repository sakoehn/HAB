/**
 * annotation-info-drawer.component.test.tsx
 * =============================================
 * Component tests for AnnotationInfoDrawer
 * (components/annotations/AnnotationInfoDrawer.tsx), the chart-card info
 * drawer on the Analyze page. Previously only covered indirectly through
 * the full App render chain in analyze-page.component.test.tsx.
 *
 * Coverage
 * --------
 *   the Parent row shows every real category for a multi-category COG
 *     (via cog_paths, the same data the hierarchy popup uses), not just the
 *     single, last-occurrence-wins stored `parent` value -- the same fetch
 *     Explore's Lookup card uses.
 *   a KEGG KO has no parent and fetches nothing; one JGI never names says
 *     so and points to its KEGG page.
 *   a renumbered enzyme shows the old EC number JGI's files use.
 *
 * Run: npx vitest run src/tests/annotation-info-drawer.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { AnnotationInfoDrawer } from '../components/annotations/AnnotationInfoDrawer'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

beforeEach(() => {
  mockFetch.mockReset()
})

async function openDrawer() {
  const user = userEvent.setup()
  await user.click(screen.getByTitle(/Show annotation details/i))
  return user
}

describe('AnnotationInfoDrawer — shows every real parent, not just the stored one', () => {
  it('shows "Parents" (plural) with both real categories for a multi-category COG', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/cog/path')) {
        return Promise.resolve(jsonResponse({
          annotation_id: 'COG0028', path_count: 2,
          paths: [
            [{ annotation_id: 'E', name: 'Amino acid transport and metabolism', depth: 1 }, { annotation_id: 'COG0028', name: 'IlvB', depth: 2 }],
            [{ annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1 }, { annotation_id: 'COG0028', name: 'IlvB', depth: 2 }],
          ],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(<AnnotationInfoDrawer annotationId="COG0028" source="cog" name="IlvB" parent="E" />)
    await openDrawer()

    await waitFor(() => {
      expect(screen.getByText('Parents')).toBeInTheDocument()
    })
    const row = screen.getByText('Parents').closest('.card-info-row')
    expect(row).toHaveTextContent('Amino acid transport and metabolism')
    expect(row).toHaveTextContent('Coenzyme transport and metabolism')
  })

  it('shows the singular "Parent" for a COG in one category', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/cog/path')) {
        return Promise.resolve(jsonResponse({
          annotation_id: 'COG0001',
          path_count: 1,
          paths: [[
            { annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1 },
            { annotation_id: 'COG0001', name: 'Glutamate-1-semialdehyde aminotransferase', depth: 2 },
          ]],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <AnnotationInfoDrawer annotationId="COG0001" source="cog" name="Glutamate-1-semialdehyde aminotransferase" parent="stale" />,
    )
    await openDrawer()

    await waitFor(() => {
      expect(screen.getByText('Parent')).toBeInTheDocument()
    })
    expect(screen.getByText('Parent').closest('.card-info-row')).toHaveTextContent(
      'Coenzyme transport and metabolism',
    )
  })

  it('does not show the stored parent while the real parents are still loading', async () => {
    let resolvePath!: (v: unknown) => void
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/cog/path')) return new Promise(r => { resolvePath = r })
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationInfoDrawer annotationId="COG0028" source="cog" name="IlvB" parent="E" />)
    await openDrawer()
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    expect(screen.queryByText('Parent')).not.toBeInTheDocument()
    expect(screen.queryByText('Parents')).not.toBeInTheDocument()

    resolvePath(jsonResponse({
      annotation_id: 'COG0028', path_count: 2,
      paths: [
        [{ annotation_id: 'E', name: 'Amino acid transport and metabolism', depth: 1 }, { annotation_id: 'COG0028', name: 'IlvB', depth: 2 }],
        [{ annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1 }, { annotation_id: 'COG0028', name: 'IlvB', depth: 2 }],
      ],
    }))
    await waitFor(() => expect(screen.getByText('Parents').closest('.card-info-row')).toHaveTextContent('Coenzyme transport and metabolism'))
  })

  it('shows the real parents even when no parent is stored', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/cog/path')) {
        return Promise.resolve(jsonResponse({
          annotation_id: 'COG0028', path_count: 2,
          paths: [
            [{ annotation_id: 'E', name: 'Amino acid transport and metabolism', depth: 1 }, { annotation_id: 'COG0028', name: 'IlvB', depth: 2 }],
            [{ annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1 }, { annotation_id: 'COG0028', name: 'IlvB', depth: 2 }],
          ],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationInfoDrawer annotationId="COG0028" source="cog" name="IlvB" parent={null} />)
    await openDrawer()
    await waitFor(() => expect(screen.getByText('Parents')).toBeInTheDocument())
    const row = screen.getByText('Parents').closest('.card-info-row')
    expect(row).toHaveTextContent('Amino acid transport and metabolism')
    expect(row).toHaveTextContent('Coenzyme transport and metabolism')
  })

  it('falls back to the stored parent value when the real-path fetch fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/cog/path')) return Promise.reject(new Error('network error'))
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <AnnotationInfoDrawer annotationId="COG9999" source="cog" name="mystery" parent="stale parent" />,
    )
    await openDrawer()

    await waitFor(() => {
      expect(screen.getByText('Parent')).toBeInTheDocument()
    })
    expect(screen.getByText('Parent').closest('.card-info-row')).toHaveTextContent('stale parent')
  })

  it('does not fetch cog paths for a taxonomy annotation -- shows the stored parent directly', async () => {
    render(
      <AnnotationInfoDrawer
        annotationId="Bacteria;Proteobacteria" source="taxonomy" name="Proteobacteria" parent="Bacteria"
      />,
    )
    await openDrawer()

    await waitFor(() => {
      expect(screen.getByText('Parent')).toBeInTheDocument()
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('AnnotationInfoDrawer — KEGG KOs are a flat list', () => {
  it('shows no parent and fetches nothing for a KO', async () => {
    render(<AnnotationInfoDrawer annotationId="K00844" source="kegg" name="hexokinase" parent={null} />)
    await openDrawer()
    expect(screen.getByText('hexokinase')).toBeInTheDocument()
    expect(screen.queryByText('Parent')).not.toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('says a KO JGI never names has no name, and still links to its KEGG page', async () => {
    render(<AnnotationInfoDrawer annotationId="K22909" source="kegg" name={null} parent={null} />)
    await openDrawer()
    expect(screen.getByTestId('info-kegg-no-name')).toHaveTextContent('JGI gives this KO no name')
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute('href', 'https://www.kegg.jp/entry/K22909')
  })
})

describe('AnnotationInfoDrawer — renumbered EC numbers', () => {
  it('shows the old EC number JGI\'s files use for a renumbered enzyme', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<AnnotationInfoDrawer annotationId="5.6.1.10" source="enzyme" name="non-chaperonin molecular chaperone ATPase" parent="5.6.1" />)
    await openDrawer()
    expect(screen.getByTestId('info-ec-renumbered')).toHaveTextContent('3.6.4.10')
  })

  it('shows nothing extra for an enzyme that was not renumbered', async () => {
    render(<AnnotationInfoDrawer annotationId="1.1.1.1" source="enzyme" name="alcohol dehydrogenase" parent="1.1.1" />)
    await openDrawer()
    expect(screen.queryByTestId('info-ec-renumbered')).not.toBeInTheDocument()
  })
})
