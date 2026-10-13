/**
 * dataset-overview-panel.component.test.tsx
 * ===========================================
 * Component tests for DatasetOverviewPanel (pages/ExplorePage.tsx),
 * covering two "Also noted" fixes from docs/AUDIT.md's Part 3 audit:
 *
 *   1. The "showing first N" truncation warning checked `rows.length === 500`
 *      while the actual fetch used `limit=200` -- the check could never
 *      fire, so a truncated "top annotations" list looked like a complete
 *      one with no indication of truncation.
 *
 *   2. The top-5-groups temporal chart fetches at most 40 member
 *      annotations' series combined across all 5 groups, silently dropping
 *      any past that -- a later group whose members all got cut could show
 *      a summed total of zero with no explanation. Now surfaced as an
 *      explicit warning instead of being silent.
 *
 * Run: npx vitest run src/tests/dataset-overview-panel.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DatasetOverviewPanel } from '../pages/ExplorePage'
import type { TopAnnotation } from '../types'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data }
}

// Captures the filename passed to downloadCsv (utils/api.ts sets
// `a.download = filename` then calls `a.click()`) without actually
// triggering a browser download.
let lastDownloadFilename: string | null = null
const originalCreateElement = document.createElement.bind(document)

beforeEach(() => {
  mockFetch.mockReset()
  lastDownloadFilename = null
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = originalCreateElement(tag)
    if (tag === 'a') {
      Object.defineProperty(el, 'click', {
        value: () => { lastDownloadFilename = (el as HTMLAnchorElement).download },
        writable: true,
      })
    }
    return el
  })
})

function makeRow(id: string, parent: string, egc: number): TopAnnotation {
  return {
    annotation_id: id, name: id, parent, mean_egc: egc, max_egc: egc * 2, sample_count: 128,
  }
}

async function loadOverview() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Load Overview/i }))
  return user
}

describe('DatasetOverviewPanel — truncation warning threshold (200 vs 500)', () => {
  it('shows the truncation note when exactly 200 rows come back (the real fetch limit)', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => makeRow(`K${i}`, `group${i % 5}`, 200 - i))
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) return Promise.resolve(jsonResponse({ data: rows, sample_count: 128 }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    await loadOverview()

    await waitFor(() => {
      expect(screen.getByText(/showing first 200/i)).toBeInTheDocument()
    })
  })

  it('does not show the truncation note when fewer than 200 rows come back', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeRow(`K${i}`, `group${i % 5}`, 50 - i))
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) return Promise.resolve(jsonResponse({ data: rows, sample_count: 128 }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    await loadOverview()

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument()
    })
    expect(screen.queryByText(/showing first/i)).not.toBeInTheDocument()
  })
})

describe('DatasetOverviewPanel — 40-annotation temporal-chart fetch cap', () => {
  it('warns when the top 5 groups have more than 40 members combined', async () => {
    // 5 groups x 10 members = 50 total, sorted so each group's sumEgc
    // differs (top5Groups picks the top 5 by sumEgc, which here is all of them).
    const rows: TopAnnotation[] = []
    for (let g = 0; g < 5; g++) {
      for (let m = 0; m < 10; m++) {
        rows.push(makeRow(`K${g}_${m}`, `group${g}`, 100 - g * 10 - m))
      }
    }
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve(jsonResponse({ data: rows, sample_count: 128 }))
      if (url.includes('/api/series/annotations'))
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'kegg', sample: 's1', annotation_id: 'K0_0', name: 'K0_0',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '5/27/21 8:00' },
            value: { egc: 10 },
          }],
        }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    const user = await loadOverview()

    await waitFor(() => screen.getByRole('button', { name: /Load time series/i }))
    await user.click(screen.getByRole('button', { name: /Load time series/i }))

    await waitFor(() => {
      expect(screen.getByTestId('overview-series-truncated-warning')).toBeInTheDocument()
    })
    expect(screen.getByTestId('overview-series-truncated-warning').textContent).toContain('50')
  })

  it('does not warn when the top 5 groups have 40 or fewer members combined', async () => {
    const rows: TopAnnotation[] = []
    for (let g = 0; g < 5; g++) {
      for (let m = 0; m < 5; m++) {
        rows.push(makeRow(`K${g}_${m}`, `group${g}`, 100 - g * 10 - m))
      }
    }
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve(jsonResponse({ data: rows, sample_count: 128 }))
      if (url.includes('/api/series/annotations'))
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'kegg', sample: 's1', annotation_id: 'K0_0', name: 'K0_0',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '5/27/21 8:00' },
            value: { egc: 10 },
          }],
        }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    const user = await loadOverview()

    await waitFor(() => screen.getByRole('button', { name: /Load time series/i }))
    await user.click(screen.getByRole('button', { name: /Load time series/i }))

    await waitFor(() => {
      expect(screen.getByText(/Summed EGC over time/i)).toBeInTheDocument()
    })
    expect(screen.queryByTestId('overview-series-truncated-warning')).not.toBeInTheDocument()
  })
})

// W29 (docs/AUDIT-2026-09-22.md): switching the source dropdown while a
// Load Overview request is still in flight used to relabel the eventually-
// returned rows under the NEW source, even though they were really fetched
// under the OLD one -- the summary line, CSV export, and the follow-up
// "Load time series" request all read the live dropdown, not what was
// actually requested.
describe('DatasetOverviewPanel — labels reflect what was actually loaded, not the live dropdown (W29)', () => {
  it('switching source while the request is in flight does not relabel the still-loading rows', async () => {
    const user = userEvent.setup()
    const rows = [makeRow('K00001', 'groupA', 100)]
    let resolveTop!: () => void
    const pending = new Promise<void>(resolve => { resolveTop = resolve })
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        return pending.then(() => jsonResponse({ data: rows, sample_count: 128 }))
      }
      if (url.includes('/api/series/annotations')) {
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'kegg', sample: 's1', annotation_id: 'K00001', name: 'K00001',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '5/27/21 8:00' },
            value: { egc: 10 },
          }],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)

    const select = screen.getByRole('combobox')
    await user.selectOptions(select, 'kegg')
    await user.click(screen.getByRole('button', { name: /Load Overview/i }))

    // Switch the dropdown to cog WHILE kegg's request is still pending.
    await user.selectOptions(select, 'cog')

    resolveTop()
    await waitFor(() => {
      expect(screen.getByText(/unique kegg annotations/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/unique cog annotations/i)).not.toBeInTheDocument()

    // CSV export: filename and each row's `source` field must say kegg,
    // never cog (the live dropdown at the time the response landed).
    await user.click(screen.getByRole('button', { name: /^↓ CSV$/i }))
    expect(lastDownloadFilename).toBe('overview_kegg.csv')

    // "Load time series" follow-up request must also target kegg.
    await user.click(await screen.findByRole('button', { name: /Load time series/i }))
    await waitFor(() => {
      const call = mockFetch.mock.calls.find(([u]) => String(u).includes('/api/series/annotations'))
      expect(call).toBeTruthy()
      expect(String(call![0])).toContain('source=kegg')
    })
  })
})

// E7 (docs/AUDIT-2026-10-05.md): groups here are formed purely by each
// row's own immediate parent, with no regard for hierarchy depth -- a
// broad category and one of its own sub-categories can both appear as
// separate "peer" groups in the same bar chart/top-5 list (live example:
// KEGG groups 09182 and 09183 are themselves both members of group 09180,
// plotted as three independent peers). Scoped to a visible disclosure
// rather than changing the grouping/ranking behavior itself.
describe('DatasetOverviewPanel — discloses that groups can be nested, not independent peers (E7)', () => {
  it('shows a help tooltip next to the groups heading explaining nested groups are not additive peers', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('K00001', '09180', 100), makeRow('K00002', '09182', 50)],
      sample_count: 128,
    }))
    const user = userEvent.setup()
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    await loadOverview()

    await waitFor(() => expect(screen.getByText(/Top Functional Groups/i)).toBeInTheDocument())

    const heading = screen.getByText(/Top Functional Groups/i).closest('span')!
    await user.click(within(heading).getByTitle('Help'))

    expect(screen.getByText(/not independent peers/i)).toBeInTheDocument()
  })
})
