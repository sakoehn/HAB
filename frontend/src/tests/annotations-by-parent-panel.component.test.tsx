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
 *   truncation note shown only at exactly 200 rows (the real fetch limit)
 *   "Summed by parent" toggle shows the aggregate table instead
 *   expanding a group fetches and renders its member series
 *   a partial per-annotation series failure shows a warning + retry
 *   expanding a group with more than 20 members discloses that its trend
 *     chart only sums the first 20
 *   collapsing and re-expanding does not re-fetch (cached), but Retry does
 *
 * Run: npx vitest run src/tests/annotations-by-parent-panel.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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

  it('shows a truncation note only when exactly 200 rows come back (the real fetch limit)', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => makeRow(`K${i}`, `group${i % 5}`, 200 - i))
    mockFetch.mockResolvedValue(jsonResponse({ data: rows }))
    render(<AnnotationsByParentPanel source="kegg" />)

    await waitFor(() => expect(screen.getByText(/Showing first 200/i)).toBeInTheDocument())
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

  // The group trend chart sums only the first 20 of a group's members, and
  // must say so -- e.g. on COG data a 200-member group's trend is the sum
  // of just 20 of them.
  it('discloses that the trend chart only sums the first 20 members when a group has more', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => makeRow(`C${i}`, 'BigGroup', 25 - i))
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) return Promise.resolve(jsonResponse({ data: rows }))
      if (url.includes('/api/series/annotations')) return Promise.resolve(jsonResponse({ data: [] }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('BigGroup')).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /BigGroup/ }))

    await waitFor(() => {
      expect(screen.getByTestId('parent-group-trend-truncated-warning')).toBeInTheDocument()
    })
    expect(screen.getByTestId('parent-group-trend-truncated-warning').textContent).toContain('25')
  })

  it('does not show the trend-truncation warning when a group has 20 or fewer members', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => makeRow(`C${i}`, 'SmallGroup', 20 - i))
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) return Promise.resolve(jsonResponse({ data: rows }))
      if (url.includes('/api/series/annotations')) return Promise.resolve(jsonResponse({ data: [] }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('SmallGroup')).toBeInTheDocument())

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /SmallGroup/ }))

    await waitFor(() => expect(screen.getByText('Mean EGC')).toBeInTheDocument())
    expect(screen.queryByTestId('parent-group-trend-truncated-warning')).not.toBeInTheDocument()
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
      // kegg rows are grouped from /api/kegg/parents' real
      // immediate-parent data, not the row's own single `parent` field.
      if (url.includes('/api/kegg/parents'))
        return Promise.resolve(jsonResponse({ parents: { K00001: [{ annotation_id: '09100', name: 'Metabolism' }] } }))
      return Promise.resolve(jsonResponse({}))
    })
    const { rerender } = render(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())

    rerender(<AnnotationsByParentPanel source="kegg" />)
    await waitFor(() => expect(screen.getByText('Metabolism')).toBeInTheDocument())
    expect(screen.queryByText('Custom Group')).not.toBeInTheDocument()
  })

  // Switching source while the PREVIOUS source's request is still in
  // flight must not let the stale (slower) response land after the newer
  // one and get labelled/grouped under the NEW source (switch from kegg to
  // cog; the slower kegg response arrives last and must not show as "cog").
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

// A KEGG row with more than one real immediate parent must be filed under EVERY
// one of them, not just the single last-occurrence-wins `parent` field
// the row itself carries.
describe('AnnotationsByParentPanel — files a multi-parent KO under every real parent group', () => {
  it('a multi-parent row appears in both of its real groups; a single-parent row appears in only one', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        return Promise.resolve(jsonResponse({
          data: [
            makeRow('K01', 'irrelevant-stale-value', 100), // real parents: Group A and Group B
            makeRow('K02', 'irrelevant-stale-value', 30),  // real parent: Group A only
          ],
        }))
      }
      if (url.includes('/api/kegg/parents')) {
        return Promise.resolve(jsonResponse({
          parents: {
            K01: [{ annotation_id: 'A', name: 'Group A' }, { annotation_id: 'B', name: 'Group B' }],
            K02: [{ annotation_id: 'A', name: 'Group A' }],
          },
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationsByParentPanel source="kegg" />)

    await waitFor(() => expect(screen.getByText('Group A')).toBeInTheDocument())
    expect(screen.getByText('Group B')).toBeInTheDocument()

    // Group A: both K01 (100) and K02 (30) -- count=2, sum=130.
    const groupARow = screen.getByText('Group A').closest('.mappings-toggle')!
    expect(groupARow.textContent).toContain('2 annotations')
    expect(groupARow.textContent).toContain('1.30e+2')

    // Group B: K01 only -- count=1, sum=100. The SAME K01 EGC (100) is
    // counted in both groups' totals (130 + 100 = 230, more than K01+K02's
    // real combined 130) -- the same already-accepted cross-group
    // non-additivity as COG's multi-category rollup, not a
    // bug to "fix" by splitting/dividing K01's value between groups.
    const groupBRow = screen.getByText('Group B').closest('.mappings-toggle')!
    expect(groupBRow.textContent).toContain('1 annotations')
    expect(groupBRow.textContent).toContain('1.00e+2')
  })

  it('a kegg row with no real parent at all (an A-level root) goes in "Top-level categories", listed last with an explanation', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve(jsonResponse({ data: [makeRow('09100', 'irrelevant', 5000), makeRow('K00001', '00010', 50)] }))
      if (url.includes('/api/kegg/parents'))
        return Promise.resolve(jsonResponse({ parents: { '09100': [], K00001: [{ annotation_id: '00010', name: 'Glycolysis' }] } }))
      return Promise.resolve(jsonResponse({}))
    })
    const user = userEvent.setup()
    render(<AnnotationsByParentPanel source="kegg" />)

    await waitFor(() => expect(screen.getByText('Top-level categories')).toBeInTheDocument())
    expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument()
    // listed after the real parent groups even though its total is larger
    const labels = [...document.querySelectorAll('.toggle-label')].map(e => e.textContent)
    expect(labels.indexOf('Top-level categories')).toBeGreaterThan(labels.indexOf('Glycolysis'))
    const row = screen.getByText('Top-level categories').closest('.parent-group')! as HTMLElement
    await user.click(within(row).getByTitle('Help'))
    expect(screen.getByText(/already includes everything beneath it/i)).toBeInTheDocument()
  })

  // On a /kegg/parents failure, rows must fall back to their own single
  // r.parent (not one undifferentiated "Ungrouped" bucket) and a visible
  // warning must be shown.
  it('falls back to single-parent grouping and shows a visible warning when /kegg/parents fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        return Promise.resolve(jsonResponse({
          data: [makeRow('K01', 'GroupOne', 100), makeRow('K02', 'GroupTwo', 50)],
        }))
      }
      if (url.includes('/api/kegg/parents')) {
        return Promise.reject(new Error('404'))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationsByParentPanel source="kegg" />)

    await waitFor(() => {
      expect(screen.getByTestId('kegg-parents-fetch-failure-warning')).toBeInTheDocument()
    })
    // Each row grouped under its OWN stored parent, not one shared
    // "Ungrouped" bucket for everything.
    expect(screen.getByText('GroupOne')).toBeInTheDocument()
    expect(screen.getByText('GroupTwo')).toBeInTheDocument()
    expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument()
  })

  it('retrying after a /kegg/parents failure can recover the real multi-parent grouping', async () => {
    let parentsCallCount = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        return Promise.resolve(jsonResponse({ data: [makeRow('K01', 'GroupOne', 100)] }))
      }
      if (url.includes('/api/kegg/parents')) {
        parentsCallCount++
        if (parentsCallCount === 1) return Promise.reject(new Error('404'))
        return Promise.resolve(jsonResponse({ parents: { K01: [{ annotation_id: 'A', name: 'Real Group A' }] } }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<AnnotationsByParentPanel source="kegg" />)

    await waitFor(() => {
      expect(screen.getByTestId('kegg-parents-fetch-failure-warning')).toBeInTheDocument()
    })
    expect(screen.getByText('GroupOne')).toBeInTheDocument() // single-parent fallback label

    const user = userEvent.setup()
    await user.click(screen.getByTestId('kegg-parents-retry-btn'))

    await waitFor(() => expect(screen.getByText('Real Group A')).toBeInTheDocument())
    expect(screen.queryByTestId('kegg-parents-fetch-failure-warning')).not.toBeInTheDocument()
  })

  it('/api/kegg/parents is never called for a non-kegg source', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('COG0001', 'Custom Group', 100)] }))
    render(<AnnotationsByParentPanel source="cog" />)

    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes('/api/kegg/parents'))).toBe(false)
  })

  // The source-switch race test (above) covers a stale response superseded
  // at the FIRST fetch (/api/annotations/top). This covers the other
  // await: a kegg request that already committed its
  // allRows/loadedSource, then gets superseded WHILE still awaiting its
  // own /api/kegg/parents call. The panel's `status` stays 'loading'
  // across that whole await specifically so nothing stale can render in
  // between -- this proves the late-resolving kegg parents response can't
  // corrupt or overwrite the newer (cog) request's already-shown result.
  // The source-switch race test (above) and the cross-source variant below
  // both supersede with a DIFFERENT source -- loadedSource ends up !=
  // 'kegg', so the grouping logic's own `if (loadedSource === 'kegg')`
  // branch never even reads multiParents, masking a missing requestId
  // check there regardless of whether it's present. This variant keeps
  // the source the SAME (kegg) across both requests specifically so a
  // missing check would be directly visible: setMultiParents replaces
  // the whole object (not a merge), so a late, stale K01-only response
  // landing after the real K02-only response would wipe out K02's entry
  // entirely, and K02 would incorrectly fall back to "Ungrouped".
  it('a stale kegg request\'s LATE /api/kegg/parents response cannot overwrite a later kegg request\'s own result', async () => {
    let resolveStaleParents!: (v: unknown) => void
    const staleParentsPending = new Promise(resolve => { resolveStaleParents = resolve })
    let keggTopCall = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('source=kegg')) {
        keggTopCall += 1
        // 1st kegg load -> K01 (whose /kegg/parents call is parked below).
        // 2nd kegg load (after bouncing through cog) -> K02, a different row.
        return Promise.resolve(jsonResponse({
          data: [keggTopCall === 1 ? makeRow('K01', 'irrelevant', 100) : makeRow('K02', 'irrelevant', 50)],
        }))
      }
      if (url.includes('/api/kegg/parents')) {
        return url.includes('ids=K01') ? staleParentsPending
          : Promise.resolve(jsonResponse({ parents: { K02: [{ annotation_id: 'B', name: 'Group B' }] } }))
      }
      if (url.includes('/api/annotations/top') && url.includes('source=cog'))
        return Promise.resolve(jsonResponse({ data: [makeRow('COG0001', 'Custom Group', 100)] }))
      return Promise.resolve(jsonResponse({}))
    })
    const { rerender } = render(<AnnotationsByParentPanel source="kegg" />)
    // Wait for K01's /api/annotations/top to actually resolve and its own
    // /api/kegg/parents call to actually START (parked pending) BEFORE
    // switching source -- otherwise K01's request can go stale before it
    // even reaches its own kegg/parents call, never exercising the race
    // this test exists to catch at all.
    await waitFor(() => {
      expect(mockFetch.mock.calls.some(([u]) => String(u).includes('ids=K01'))).toBe(true)
    })

    // Bounce through cog and back to kegg -- a brand new kegg request
    // (K02) starts and fully completes (real Group B grouping shown)
    // while K01's parents call is still stuck.
    rerender(<AnnotationsByParentPanel source="cog" />)
    await waitFor(() => expect(screen.getByText('Custom Group')).toBeInTheDocument())
    rerender(<AnnotationsByParentPanel source="kegg" />)
    await waitFor(() => expect(screen.getByText('Group B')).toBeInTheDocument())

    // Now let the stale K01 request's /api/kegg/parents finally land.
    resolveStaleParents(jsonResponse({ parents: { K01: [{ annotation_id: 'A', name: 'Group A (STALE)' }] } }))
    await new Promise(r => setTimeout(r, 20))

    // K02's real grouping must still be shown -- the stale K01-only
    // response must not have replaced it (which would leave K02 with no
    // entry in multiParents at all, falling back to "Ungrouped").
    expect(screen.getByText('Group B')).toBeInTheDocument()
    expect(screen.queryByText('Group A (STALE)')).not.toBeInTheDocument()
    expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument()
  })
})
