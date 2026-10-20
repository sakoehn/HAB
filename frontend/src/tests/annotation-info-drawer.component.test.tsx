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
 *   the Parent row shows every real parent for a multi-parent KEGG KO or
 *     multi-category COG (via kegg_paths/cog_paths, the same data the
 *     hierarchy popup uses), not just the single, last-occurrence-wins
 *     stored `parent` value -- the same fetch Explore's Lookup card uses.
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
  it('shows "Parents" (plural) with every real pathway parent for a multi-parent KEGG KO', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/kegg/path')) {
        return Promise.resolve(jsonResponse({
          annotation_id: 'K00844',
          path_count: 2,
          paths: [
            [
              { annotation_id: '09100', name: 'Metabolism', depth: 1 },
              { annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2 },
              { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 3 },
              { annotation_id: 'K00844', name: 'HK; hexokinase', depth: 4 },
            ],
            [
              { annotation_id: '09100', name: 'Metabolism', depth: 1 },
              { annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2 },
              { annotation_id: '00051', name: 'Fructose and mannose metabolism', depth: 3 },
              { annotation_id: 'K00844', name: 'HK; hexokinase', depth: 4 },
            ],
          ],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <AnnotationInfoDrawer
        annotationId="K00844" source="kegg" name="HK; hexokinase" parent="09180 Brite Hierarchies"
      />,
    )
    await openDrawer()

    await waitFor(() => {
      expect(screen.getByText('Parents')).toBeInTheDocument()
    })
    const row = screen.getByText('Parents').closest('.card-info-row')
    expect(row).toHaveTextContent('Glycolysis / Gluconeogenesis')
    expect(row).toHaveTextContent('Fructose and mannose metabolism')
    // Must not still show the single stale stored value instead.
    expect(row).not.toHaveTextContent('Brite Hierarchies')
  })

  it('shows the singular "Parent" with the one real parent for a single-parent KEGG KO', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/kegg/path')) {
        return Promise.resolve(jsonResponse({
          annotation_id: 'K02014',
          path_count: 1,
          paths: [[
            { annotation_id: '09100', name: 'Metabolism', depth: 1 },
            { annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2 },
            { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 3 },
            { annotation_id: 'K02014', name: 'K02014 protein', depth: 4 },
          ]],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <AnnotationInfoDrawer annotationId="K02014" source="kegg" name="K02014 protein" parent="stale" />,
    )
    await openDrawer()

    await waitFor(() => {
      expect(screen.getByText('Parent')).toBeInTheDocument()
    })
    expect(screen.getByText('Parent').closest('.card-info-row')).toHaveTextContent(
      'Glycolysis / Gluconeogenesis',
    )
  })

  it('falls back to the stored parent value when the real-path fetch fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/kegg/path')) return Promise.reject(new Error('network error'))
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <AnnotationInfoDrawer annotationId="K99999" source="kegg" name="mystery" parent="stale parent" />,
    )
    await openDrawer()

    await waitFor(() => {
      expect(screen.getByText('Parent')).toBeInTheDocument()
    })
    expect(screen.getByText('Parent').closest('.card-info-row')).toHaveTextContent('stale parent')
  })

  it('does not fetch kegg/cog paths for a taxonomy annotation -- shows the stored parent directly', async () => {
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
