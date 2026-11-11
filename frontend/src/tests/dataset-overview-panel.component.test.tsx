/**
 * dataset-overview-panel.component.test.tsx
 * ===========================================
 * Component tests for DatasetOverviewPanel (pages/ExplorePage.tsx),
 * covering two truncation disclosures:
 *
 *   1. The "showing first N" truncation warning must match the actual
 *      fetch's `limit=200`, or a truncated "top annotations" list would
 *      look complete.
 *
 *   2. The top-5-groups temporal chart fetches at most 40 member
 *      annotations' series combined across all 5 groups -- a later group
 *      whose members all got cut could otherwise show a summed total of
 *      zero with no explanation, so an explicit warning is shown.
 *
 * Run: npx vitest run src/tests/dataset-overview-panel.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
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
    // A date filter never lifts the server's 200-row limit.
    expect(screen.getByText(/showing first 200/i).textContent).not.toMatch(/date/i)
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
    expect(screen.getByTestId('overview-series-truncated-warning').textContent).not.toMatch(/date range/i)
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
      expect(screen.getByText(/Summed over time/i)).toBeInTheDocument()
    })
    expect(screen.queryByTestId('overview-series-truncated-warning')).not.toBeInTheDocument()
  })
})

// Switching the source dropdown while a Load Overview request is still in
// flight must not relabel the eventually-returned rows under the NEW
// source -- the summary line, CSV export, and the follow-up "Load time
// series" request must all read what was actually requested, not the live
// dropdown.
describe('DatasetOverviewPanel — labels reflect what was actually loaded, not the live dropdown', () => {
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

// Groups here are formed purely by each
// row's own immediate parent, with no regard for hierarchy depth -- a
// broad category and one of its own sub-categories can both appear as
// separate "peer" groups in the same bar chart/top-5 list (e.g. KEGG groups
// 09182 and 09183 are themselves both members of group 09180, plotted as
// three independent peers), so the panel discloses it.
describe('DatasetOverviewPanel — discloses that groups can be nested, not independent peers', () => {
  it('shows a help tooltip next to the groups heading explaining nested groups are not additive peers', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('K00001', '09180', 100), makeRow('K00002', '09182', 50)],
      sample_count: 128,
    }))
    const user = userEvent.setup()
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    await loadOverview()

    await waitFor(() => expect(screen.getByText(/Top Parent Groups/i)).toBeInTheDocument())

    const heading = screen.getByText(/Top Parent Groups/i).closest('span')!
    await user.click(within(heading).getByTitle('Help'))

    expect(screen.getByText(/not independent peers/i)).toBeInTheDocument()
  })
})

// UI round 2026-10-14: rows with no parent (each source's top-level
// categories) used to form an "Ungrouped" group that ranked #1 -- its total
// summed the categories themselves, each of which already includes every
// annotation beneath it, i.e. the same genes the other groups count. They're
// now a separate, expandable "Top-level categories" row outside the ranking
// and the chart.
describe('DatasetOverviewPanel — top-level categories are listed separately, not ranked as "Ungrouped"', () => {
  const ROWS: TopAnnotation[] = [
    { annotation_id: 'E', name: 'Amino acid transport and metabolism', parent: null, mean_egc: 5000, max_egc: 6000, sample_count: 128 },
    { annotation_id: 'J', name: 'Translation, ribosomal structure and biogenesis', parent: null, mean_egc: 4000, max_egc: 5000, sample_count: 128 },
    { annotation_id: 'COG0001', name: 'gene one', parent: 'E', mean_egc: 300, max_egc: 400, sample_count: 128 },
    { annotation_id: 'COG0002', name: 'gene two', parent: 'J', mean_egc: 200, max_egc: 300, sample_count: 128 },
  ]

  async function loadCog() {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) return Promise.resolve(jsonResponse({ data: ROWS, sample_count: 128 }))
      return Promise.resolve(jsonResponse({ data: [] }))
    })
    const user = userEvent.setup()
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    await user.selectOptions(screen.getByRole('combobox'), 'cog')
    await loadOverview()
    await waitFor(() => expect(screen.getByText(/Top Parent Groups/i)).toBeInTheDocument())
    return user
  }

  it('no "Ungrouped" group, and the ranked groups are only real parents', async () => {
    await loadCog()
    expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument()
    // header count reflects ranked groups only (E and J as parents)
    expect(screen.getByText(/parent groups/).parentElement!.textContent).toMatch(/\b2\s*parent groups/)
  })

  it('the distribution says it covers the loaded top annotations only', async () => {
    await loadCog()
    expect(screen.getAllByText(new RegExp(`Mean EGC distribution · top ${ROWS.length} cog annotations`)).length).toBeGreaterThan(0)
  })

  it('a separate "Top-level categories" row explains the overlap in a tooltip', async () => {
    const user = await loadCog()
    const row = screen.getByTestId('overview-top-level-row')
    expect(row).toHaveTextContent('Top-level categories')
    expect(row).toHaveTextContent('2')
    await user.click(within(row).getByTitle('Help'))
    expect(screen.getByText(/already includes everything beneath it/i)).toBeInTheDocument()
  })

  it('expands to list each top-level category with its full name and mean EGC', async () => {
    const user = await loadCog()
    expect(screen.queryByText('E · Amino acid transport and metabolism')).not.toBeInTheDocument()
    await user.click(within(screen.getByTestId('overview-top-level-row')).getByRole('button', { name: /top-level categories/i }))
    const list = screen.getByTestId('overview-top-level-list')
    expect(within(list).getByText('E · Amino acid transport and metabolism')).toBeInTheDocument()
    expect(within(list).getByText('J · Translation, ribosomal structure and biogenesis')).toBeInTheDocument()
    expect(list).toHaveTextContent('5.00e+3')
  })

  it('the time-series chart fetches only ranked groups\' members, never the top-level rows', async () => {
    const user = await loadCog()
    await user.click(screen.getByRole('button', { name: /Load time series/i }))
    await waitFor(() => {
      const urls = mockFetch.mock.calls.map(c => c[0] as string).filter(u => u.includes('/api/series/annotations'))
      expect(urls.length).toBe(2)
    })
    const urls = mockFetch.mock.calls.map(c => c[0] as string).filter(u => u.includes('/api/series/annotations'))
    expect(urls.some(u => /annotation_id=(E|J)&/.test(u))).toBe(false)
  })
})

// Groups must reflect every real parent of a multi-parent KO or
// multi-category COG, not just the single stored `parent` value.
describe('DatasetOverviewPanel — groups use every real parent for kegg and cog', () => {
  it('files a multi-category COG under both of its categories', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve(jsonResponse({ data: [makeRow('COG0028', 'E', 100)], sample_count: 128 }))
      if (url.includes('/api/cog/parents'))
        return Promise.resolve(jsonResponse({
          parents: {
            COG0028: [
              { annotation_id: 'E', name: 'Amino acid transport and metabolism' },
              { annotation_id: 'H', name: 'Coenzyme transport and metabolism' },
            ],
          },
        }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    await user.selectOptions(screen.getByRole('combobox'), 'cog')
    await user.click(screen.getByRole('button', { name: /Load Overview/i }))

    await waitFor(() => expect(screen.getByTitle('Coenzyme transport and metabolism')).toBeInTheDocument())
    expect(screen.getByTitle('Amino acid transport and metabolism')).toBeInTheDocument()
  })
})

describe('DatasetOverviewPanel — a chart started for earlier rows is dropped', () => {
  it('reloading the overview while the time series loads discards that time series', async () => {
    const rows = [makeRow('K1', 'group1', 10), makeRow('K2', 'group2', 5)]
    const held: (() => void)[] = []
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve(jsonResponse({ data: rows, sample_count: 128 }))
      if (url.includes('/api/series/annotations'))
        return new Promise(resolve => held.push(() => resolve(jsonResponse({ data: [] }))))
      return Promise.resolve(jsonResponse({}))
    })
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    const user = await loadOverview()
    await user.click(await screen.findByRole('button', { name: /Load time series/i }))
    await waitFor(() => expect(held.length).toBeGreaterThan(0))

    await loadOverview()                         // new rows; the chart starts over
    await screen.findByRole('button', { name: /Load time series/i })
    held.forEach(release => release())           // the old time series arrives late
    await new Promise(r => setTimeout(r, 50))

    expect(screen.getByRole('button', { name: /Load time series/i })).toBeInTheDocument()
  })
})

describe('DatasetOverviewPanel — group size is the own total of the category', () => {
  function mockWithOwnTotals(own: Record<string, number>) {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('ids=')) {
        const ids = new URL(url, 'http://x').searchParams.getAll('ids')
        return Promise.resolve(jsonResponse({ data: ids.filter(id => id in own).map(id => makeRow(id, '', own[id])), sample_count: 128 }))
      }
      if (url.includes('/api/annotations/top'))
        return Promise.resolve(jsonResponse({
          data: [makeRow('2.7.1.1', '2.7.1', 10), makeRow('2.7.1.2', '2.7.1', 5), makeRow('3.1.1.1', '3.1.1', 40)],
          sample_count: 128,
        }))
      return Promise.resolve(jsonResponse({}))
    })
  }

  async function loadEnzymeOverview() {
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByDisplayValue(/taxonomy/i), 'enzyme')
    await user.click(screen.getByRole('button', { name: /Load Overview/i }))
    return user
  }

  it('ranks groups by the own total of the category and shows it, with the member sum on hover', async () => {
    mockWithOwnTotals({ '2.7.1': 100, '3.1.1': 50 })
    await loadEnzymeOverview()

    const first = await screen.findByTitle(/Category total 1\.00e\+2/)
    expect(first).toHaveTextContent('1.00e+2')
    expect(first.getAttribute('title')).toMatch(/Σ of the 2 listed members: 1\.50e\+1/)
    const totals = screen.getAllByTitle(/Category total/).map(el => el.textContent)
    expect(totals).toEqual(['1.00e+2', '5.00e+1'])
    expect(screen.getByText(/Top Parent Groups by Mean EGC/i)).toBeInTheDocument()
  })

  it('a date range goes into the request for the own totals of the categories', async () => {
    mockWithOwnTotals({ '2.7.1': 100, '3.1.1': 50 })
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByDisplayValue(/taxonomy/i), 'enzyme')
    const [fromInput] = document.querySelectorAll('input[type="date"]')
    fireEvent.change(fromInput, { target: { value: '2021-06-02' } })
    await user.click(screen.getByRole('button', { name: /Load Overview/i }))

    await screen.findByTitle(/Category total 1\.00e\+2/)
    const idsCall = mockFetch.mock.calls.map(c => String(c[0])).find(u => u.includes('ids='))!
    expect(idsCall).toContain('date_from=2021-06-02')
  })
})
