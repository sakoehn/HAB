/**
 * annotations-by-parent-panel.component.test.tsx
 * ==================================================
 * Component tests for AnnotationsByParentPanel (pages/ExplorePage.tsx) --
 * the Explore page's "group by parent category" view. Found completely
 * untested by a coverage pass (0% on every function in this component):
 * loading/error/empty states, the group-trend-vs-summed toggle, expanding a
 * parent group to fetch and chart its members' series, and per-group
 * partial-failure handling were all previously unverified.
 *
 * Coverage
 * --------
 *   loading state, error state + retry re-fetches, empty state
 *   groups rendered sorted by summed EGC descending
 *   truncation note shown only at exactly 500 rows (the real fetch limit)
 *   "Summed by parent" toggle shows the aggregate table instead
 *   expanding a group fetches and renders its member series
 *   a partial per-annotation series failure shows a warning + retry
 *   collapsing and re-expanding does not re-fetch (cached), but Retry does
 *
 * Run: npx vitest run src/tests/annotations-by-parent-panel.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { AnnotationsByParentPanel } from '../pages/ExplorePage'
import type { TopAnnotation } from '../types'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data }
}

beforeEach(() => {
  mockFetch.mockReset()
})

function makeRow(id: string, parent: string, egc: number): TopAnnotation {
  return {
    annotation_id: id, name: id, parent, mean_egc: egc, max_egc: egc * 2, sample_count: 128,
  }
}

describe('AnnotationsByParentPanel — loading, error, empty states', () => {
  it('shows a loading state before the fetch resolves', () => {
    mockFetch.mockReturnValue(new Promise(() => {})) // never resolves
    render(<AnnotationsByParentPanel source="cog" />)
    expect(screen.getByText(/Loading annotations/i)).toBeInTheDocument()
  })

  it('shows an error state with a working retry button', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    render(<AnnotationsByParentPanel source="cog" />)

    await waitFor(() => expect(screen.getByText(/Failed to load/i)).toBeInTheDocument())

    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('COG0001', 'Custom Group', 100)] }))
    const user = userEvent.setup()
    await user.click(screen.getByTestId('parent-panel-retry-btn'))

    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())
  })

  it('shows an empty-state message when there are no rows', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }))
    render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => {
      expect(screen.getByText(/No parent groupings found for cog/i)).toBeInTheDocument()
    })
  })
})

describe('AnnotationsByParentPanel — parent grouping and sort order', () => {
  it('groups rows by parent and sorts groups by summed EGC descending', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [
        makeRow('A1', 'LowGroup', 10),
        makeRow('B1', 'HighGroup', 500),
        makeRow('B2', 'HighGroup', 400),
      ],
    }))
    render(<AnnotationsByParentPanel source="cog" />)

    await waitFor(() => expect(screen.getByText('HighGroup')).toBeInTheDocument())

    const labels = screen.getAllByText(/Group$/).map(el => el.textContent)
    expect(labels).toEqual(['HighGroup', 'LowGroup'])
  })

  it('shows a truncation note only when exactly 500 rows come back', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => makeRow(`K${i}`, `group${i % 5}`, 500 - i))
    mockFetch.mockResolvedValue(jsonResponse({ data: rows }))
    render(<AnnotationsByParentPanel source="kegg" />)

    await waitFor(() => expect(screen.getByText(/Showing first 500/i)).toBeInTheDocument())
  })

  it('does not show a truncation note when fewer than 500 rows come back', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('COG0001', 'Custom Group', 100)] }))
    render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())
    expect(screen.queryByText(/Showing first/i)).not.toBeInTheDocument()
  })
})

describe('AnnotationsByParentPanel — summed vs group-trend view toggle', () => {
  it('defaults to the group-trend-and-detail view (toggle rows, no aggregate table)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('COG0001', 'Custom Group', 100)] }))
    render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())
    expect(screen.queryByText('Σ Mean EGC')).not.toBeInTheDocument()
  })

  it('switching to "Summed by parent" shows the aggregate table instead', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('COG0001', 'Custom Group', 100), makeRow('COG0002', 'Other Group', 50)],
    }))
    render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Summed by parent/i }))

    expect(screen.getByText('Σ Mean EGC')).toBeInTheDocument()
    // Aggregate view has no per-group expand toggle.
    expect(screen.queryByRole('button', { name: /Custom Group\s*\d+ annotations/i })).not.toBeInTheDocument()
  })
})

describe('AnnotationsByParentPanel — expanding a group to load its series', () => {
  it('expanding a group fetches and renders each member\'s series in a table', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        return Promise.resolve(jsonResponse({ data: [makeRow('COG0001', 'Custom Group', 100)] }))
      }
      if (url.includes('/api/series/annotations')) {
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'cog', sample: 's1', annotation_id: 'COG0001', name: 'COG0001',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '5/27/21 8:00' },
            value: { egc: 100 },
          }],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Custom Group/ }))

    // COG0001 legitimately appears twice once the chart renders too (its
    // own id + name both being "COG0001") -- assert presence, not uniqueness.
    await waitFor(() => expect(screen.getAllByText('COG0001').length).toBeGreaterThan(0))
    expect(screen.getByText('Mean EGC')).toBeInTheDocument()
  })

  it('shows a partial-failure warning with a working retry when some member fetches fail', async () => {
    let seriesCallCount = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        return Promise.resolve(jsonResponse({
          data: [makeRow('COG0001', 'Custom Group', 100), makeRow('COG0002', 'Custom Group', 90)],
        }))
      }
      if (url.includes('/api/series/annotations')) {
        seriesCallCount++
        if (url.includes('COG0001')) return Promise.reject(new Error('fetch failed'))
        return Promise.resolve(jsonResponse({ data: [] }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Custom Group/ }))

    await waitFor(() => {
      expect(screen.getByTestId('parent-group-failure-warning')).toBeInTheDocument()
    })
    expect(screen.getByTestId('parent-group-failure-warning').textContent).toContain('COG0001')

    // Retry re-fetches (force=true) rather than being permanently stuck.
    const callsBeforeRetry = seriesCallCount
    await user.click(screen.getByTestId('parent-group-retry-btn'))
    await waitFor(() => expect(seriesCallCount).toBeGreaterThan(callsBeforeRetry))
  })

  it('does not re-fetch when collapsing and re-expanding the same group', async () => {
    let seriesCallCount = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        return Promise.resolve(jsonResponse({ data: [makeRow('COG0001', 'Custom Group', 100)] }))
      }
      if (url.includes('/api/series/annotations')) {
        seriesCallCount++
        return Promise.resolve(jsonResponse({ data: [] }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())

    const user = userEvent.setup()
    const toggleBtn = screen.getByRole('button', { name: /Custom Group/ })
    await user.click(toggleBtn) // expand -- fetches
    await waitFor(() => expect(seriesCallCount).toBe(1))

    await user.click(toggleBtn) // collapse
    await user.click(toggleBtn) // re-expand -- cached, no new fetch

    expect(seriesCallCount).toBe(1)
  })
})

describe('AnnotationsByParentPanel — re-fetches when the source prop changes', () => {
  it('changing source triggers a fresh load', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('source=cog'))
        return Promise.resolve(jsonResponse({ data: [makeRow('COG0001', 'Custom Group', 100)] }))
      if (url.includes('source=kegg'))
        return Promise.resolve(jsonResponse({ data: [makeRow('K00001', 'Metabolism', 50)] }))
      return Promise.resolve(jsonResponse({}))
    })
    const { rerender } = render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())

    rerender(<AnnotationsByParentPanel source="kegg" />)
    await waitFor(() => expect(screen.getByText('Metabolism')).toBeInTheDocument())
    expect(screen.queryByText('Custom Group')).not.toBeInTheDocument()
  })

  // W29 (docs/AUDIT-2026-09-22.md): switching source while the PREVIOUS
  // source's request is still in flight used to let the stale (slower)
  // response land after the newer one and get labelled/grouped under the
  // NEW source -- the audit's own live example: "switch from kegg to cog.
  // The slower kegg response arrives last and is shown under 'cog'."
  it('a stale response from the OLD source is ignored, even if it resolves after the new source\'s real response', async () => {
    let resolveKegg!: (v: unknown) => void
    const keggPending = new Promise(resolve => { resolveKegg = resolve })
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('source=kegg')) return keggPending
      if (url.includes('source=cog'))
        return Promise.resolve(jsonResponse({ data: [makeRow('COG0001', 'Custom Group', 100)] }))
      return Promise.resolve(jsonResponse({}))
    })
    const { rerender } = render(<AnnotationsByParentPanel source="kegg" />)

    // Switch to cog BEFORE kegg's request resolves.
    rerender(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())

    // Now let the stale kegg response land.
    resolveKegg(jsonResponse({ data: [makeRow('K00001', 'Metabolism', 50)] }))
    await new Promise(r => setTimeout(r, 20))

    // Still showing cog's real data -- kegg's late response must not have
    // overwritten it, and must not be shown labelled as "cog" either.
    expect(screen.getByText('Custom Group')).toBeInTheDocument()
    expect(screen.queryByText('Metabolism')).not.toBeInTheDocument()
  })
})
