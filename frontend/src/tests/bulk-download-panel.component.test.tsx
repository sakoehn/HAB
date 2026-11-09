/**
 * bulk-download-panel.component.test.tsx
 * ======================================
 * Tests for BulkDownloadPanel (components/download/BulkDownloadPanel.tsx)
 * and its helpers (utils/bulkDownload.ts),
 * the Explore page's "Bulk Download" section: pick a starting taxon and a
 * deeper rank, see the size, download the CSV from /api/series/export.
 *
 * Coverage
 * --------
 *   rankOptionsBelow / buildExportQuery (pure helpers)
 *   a handed-in starting taxon is shown and used for the summary request
 *   the rank dropdown only offers ranks below the starting taxon, defaults
 *     to the next one down, and keeps a still-valid choice when the start
 *     changes
 *   size line, the too-big-for-Excel note, the nothing-found and error
 *     states, and the download link's URL
 *   picking a start by search and going back to the whole dataset
 *   date range is passed through to both requests
 *   every source can be chosen
 *   cog: levels, the review list worded for categories, its note
 *   kegg: the review list of KOs in several pathways and the choices sent
 *     with the size request and the download
 *   enzyme: levels, search, browse tree, the note about totals not adding up
 *   the "also include the starting term" option
 *   a slower, superseded summary response is ignored
 *
 * Run: npx vitest run src/tests/bulk-download-panel.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { BulkDownloadPanel } from '../components/download/BulkDownloadPanel'
import { buildExportQuery, canBulkDownloadFrom, levelOptionsBelow, rankOptionsBelow } from '../utils/bulkDownload'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data }
}

const GAMMA = 'Bacteria;Proteobacteria;Gammaproteobacteria'

function summary(over: Partial<{ taxa: number; samples: number; max_rows: number; sparse: boolean }> = {}) {
  return { source: 'taxonomy', parent: GAMMA, rank: 'family', taxa: 76, samples: 128, max_rows: 9728, sparse: false, ...over }
}

function summaryUrls(): URL[] {
  return mockFetch.mock.calls
    .map(c => new URL(String(c[0]), 'http://x'))
    .filter(u => u.pathname === '/api/series/export/summary')
}

function lastSummaryUrl(): URL {
  const urls = summaryUrls()
  return urls[urls.length - 1]
}

function rankSelect() {
  return screen.getByLabelText('Download every') as HTMLSelectElement
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue(jsonResponse(summary()))
})

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('rankOptionsBelow', () => {
  it('offers every rank for the whole dataset', () => {
    expect(rankOptionsBelow(null).map(o => o.value)).toEqual(
      ['domain', 'phylum', 'class', 'order', 'family', 'genus', 'species', 'strain'],
    )
  })

  it('offers only ranks deeper than the starting taxon', () => {
    expect(rankOptionsBelow(GAMMA).map(o => o.value)).toEqual(['order', 'family', 'genus', 'species', 'strain'])
  })

  it('offers nothing below a strain', () => {
    expect(rankOptionsBelow('a;b;c;d;e;f;g;h')).toEqual([])
  })
})

describe('buildExportQuery', () => {
  it('encodes the parent and leaves out empty values', () => {
    const q = new URLSearchParams(buildExportQuery({ source: 'taxonomy', parent: GAMMA, rank: 'family', dateFrom: '', dateTo: '' }))
    expect(Object.fromEntries(q)).toEqual({ source: 'taxonomy', rank: 'family', parent: GAMMA })
  })

  it('leaves out the parent for the whole dataset and keeps dates', () => {
    const q = new URLSearchParams(buildExportQuery({ source: 'taxonomy', parent: null, rank: 'phylum', dateFrom: '2021-06-01', dateTo: '2021-06-05' }))
    expect(Object.fromEntries(q)).toEqual({ source: 'taxonomy', rank: 'phylum', date_from: '2021-06-01', date_to: '2021-06-05' })
  })
})

// ── Component ────────────────────────────────────────────────────────────────

describe('BulkDownloadPanel', () => {
  it('starts from a handed-in taxon and defaults to the next rank down', async () => {
    render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Bacteria › Proteobacteria › Gammaproteobacteria')
    await waitFor(() => expect(lastSummaryUrl()?.searchParams.get('parent')).toBe(GAMMA))
    expect(lastSummaryUrl().searchParams.get('rank')).toBe('order')
    expect([...rankSelect().options].map(o => o.value)).toEqual(['order', 'family', 'genus', 'species', 'strain'])
  })

  it('shows the size and links the download to the chosen rank', async () => {
    const user = userEvent.setup()
    render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    await user.selectOptions(rankSelect(), 'family')
    await waitFor(() => expect(lastSummaryUrl().searchParams.get('rank')).toBe('family'))
    expect(await screen.findByTestId('bulk-size')).toHaveTextContent('76 families × 128 samples ≈ 9,728 rows')
    const link = screen.getByRole('link', { name: /Download CSV/ })
    const href = new URL(link.getAttribute('href')!, 'http://x')
    expect(href.pathname).toBe('/api/series/export')
    expect(Object.fromEntries(href.searchParams)).toEqual({ source: 'taxonomy', rank: 'family', parent: GAMMA })
  })

  it('explains when the file is too big for Excel', async () => {
    mockFetch.mockResolvedValue(jsonResponse(summary({ taxa: 18347, max_rows: 2348416, sparse: true })))
    render(<BulkDownloadPanel initialParent={{ lineage: 'Bacteria' }} />)
    expect(await screen.findByTestId('bulk-sparse-note')).toHaveTextContent(/too large to open in Excel/i)
  })

  it('does not show the Excel note for a normal-sized file', async () => {
    render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    await screen.findByTestId('bulk-size')
    expect(screen.queryByTestId('bulk-sparse-note')).toBeNull()
  })

  it('disables the download when nothing is under the starting taxon', async () => {
    mockFetch.mockResolvedValue(jsonResponse(summary({ taxa: 0, max_rows: 0 })))
    render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    expect(await screen.findByTestId('bulk-size')).toHaveTextContent(/no orders/i)
    expect(screen.queryByRole('link', { name: /Download CSV/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled()
  })

  it('shows an error and disables the download when the summary fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'err', json: async () => ({}) })
    render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    expect(await screen.findByTestId('bulk-error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled()
  })

  it('keeps the chosen rank when the new start is still above it, otherwise moves to the next rank down', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    await user.selectOptions(rankSelect(), 'species')
    rerender(<BulkDownloadPanel initialParent={{ lineage: `${GAMMA};Pseudomonadales;Pseudomonadaceae` }} />)
    await waitFor(() => expect(lastSummaryUrl().searchParams.get('parent')).toBe(`${GAMMA};Pseudomonadales;Pseudomonadaceae`))
    expect(rankSelect().value).toBe('species')

    rerender(<BulkDownloadPanel initialParent={{ lineage: `${GAMMA};Pseudomonadales;Pseudomonadaceae;Pseudomonas;Pseudomonas putida` }} />)
    await waitFor(() => expect(rankSelect().value).toBe('strain'))
  })

  it('picks a starting taxon by search, and can go back to the whole dataset', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/search/annotations')) {
        return jsonResponse({ data: [{ annotation_id: GAMMA, name: 'Gammaproteobacteria', depth: 3 }], total: 1 })
      }
      return jsonResponse(summary())
    })
    render(<BulkDownloadPanel />)
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Whole dataset')

    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.type(screen.getByPlaceholderText(/Search for a taxon/), 'Gammaproteobacteria{Enter}')
    const searchCall = mockFetch.mock.calls.map(c => String(c[0])).find(u => u.startsWith('/api/search/annotations'))!
    expect(new URL(searchCall, 'http://x').searchParams.get('sources')).toBe('taxonomy')
    await user.click(await screen.findByRole('button', { name: /Gammaproteobacteria/ }))

    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Gammaproteobacteria')
    await waitFor(() => expect(lastSummaryUrl().searchParams.get('parent')).toBe(GAMMA))

    await user.click(screen.getByRole('button', { name: 'Whole dataset' }))
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Whole dataset')
    await waitFor(() => expect(lastSummaryUrl().searchParams.has('parent')).toBe(false))
  })

  it('passes the date range to the summary and the download', async () => {
    const { container } = render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    const [from, to] = container.querySelectorAll('input[type="date"]')
    fireEvent.change(from, { target: { value: '2021-06-01' } })
    fireEvent.change(to, { target: { value: '2021-06-05' } })
    await waitFor(() => expect(lastSummaryUrl().searchParams.get('date_to')).toBe('2021-06-05'))
    expect(lastSummaryUrl().searchParams.get('date_from')).toBe('2021-06-01')
    const href = new URL(screen.getByRole('link', { name: /Download CSV/ }).getAttribute('href')!, 'http://x')
    expect(href.searchParams.get('date_from')).toBe('2021-06-01')
    expect(href.searchParams.get('date_to')).toBe('2021-06-05')
  })

  it('offers every source', () => {
    render(<BulkDownloadPanel />)
    const options = [...(screen.getByLabelText('Source') as HTMLSelectElement).options]
    expect(options.map(o => [o.value, o.disabled])).toEqual([
      ['taxonomy', false], ['enzyme', false], ['kegg', false], ['cog', false],
    ])
  })

  it('ignores a slower response for a choice that has since changed', async () => {
    const user = userEvent.setup()
    let resolveFirst!: (v: unknown) => void
    mockFetch.mockImplementationOnce(() => new Promise(r => { resolveFirst = r }))
    mockFetch.mockResolvedValue(jsonResponse(summary({ taxa: 76 })))
    render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    await user.selectOptions(rankSelect(), 'family')
    expect(await screen.findByTestId('bulk-size')).toHaveTextContent('76 families')
    resolveFirst(jsonResponse(summary({ taxa: 12, max_rows: 1536 })))
    await new Promise(r => setTimeout(r, 0))
    expect(screen.getByTestId('bulk-size')).toHaveTextContent('76 families')
  })
})

// ── Enzyme and the starting-term option ─────────────────────────────────────

describe('levelOptionsBelow', () => {
  it('lists the enzyme levels below a starting level', () => {
    expect(levelOptionsBelow('enzyme', 0).map(o => o.value)).toEqual(['class', 'subclass', 'subsubclass', 'ec'])
    expect(levelOptionsBelow('enzyme', 3).map(o => [o.value, o.label])).toEqual([['ec', 'EC number']])
    expect(levelOptionsBelow('enzyme', 4)).toEqual([])
  })

  it('matches rankOptionsBelow for taxonomy', () => {
    expect(levelOptionsBelow('taxonomy', 3)).toEqual(rankOptionsBelow(GAMMA))
  })
})

describe('buildExportQuery — starting term', () => {
  it('adds include_parent only when asked and there is a start', () => {
    const base = { source: 'enzyme', rank: 'ec', dateFrom: '', dateTo: '' }
    expect(new URLSearchParams(buildExportQuery({ ...base, parent: '5.6.2', includeParent: true })).get('include_parent')).toBe('true')
    expect(new URLSearchParams(buildExportQuery({ ...base, parent: '5.6.2', includeParent: false })).has('include_parent')).toBe(false)
    expect(new URLSearchParams(buildExportQuery({ ...base, parent: null, includeParent: true })).has('include_parent')).toBe(false)
  })
})

describe('BulkDownloadPanel — Enzyme', () => {
  function enzymeFetch() {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/search/annotations')) {
        return jsonResponse({ data: [{ annotation_id: '5.6.2', name: 'Enzymes altering nucleic acid conformation', depth: 3 }], total: 1 })
      }
      if (url.startsWith('/api/enzyme/children')) {
        return jsonResponse({ data: [{ annotation_id: '5', name: 'Isomerases', depth: 1, category: 'Isomerases' }] })
      }
      return jsonResponse(summary({ taxa: 2, max_rows: 256 }))
    })
  }

  async function switchToEnzyme(user: ReturnType<typeof userEvent.setup>) {
    await user.selectOptions(screen.getByLabelText('Source'), 'enzyme')
  }

  it('switching to enzyme starts from the whole dataset with enzyme levels', async () => {
    enzymeFetch()
    const user = userEvent.setup()
    render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    await switchToEnzyme(user)
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Whole dataset')
    expect([...rankSelect().options].map(o => o.value)).toEqual(['class', 'subclass', 'subsubclass', 'ec'])
    await waitFor(() => expect(lastSummaryUrl().searchParams.get('source')).toBe('enzyme'))
    expect(lastSummaryUrl().searchParams.get('rank')).toBe('class')
    expect(lastSummaryUrl().searchParams.has('parent')).toBe(false)
  })

  it('searches enzyme terms and starts from the one picked', async () => {
    enzymeFetch()
    const user = userEvent.setup()
    render(<BulkDownloadPanel />)
    await switchToEnzyme(user)
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.type(screen.getByPlaceholderText(/Search for/), 'nucleic{Enter}')
    const searchCall = mockFetch.mock.calls.map(c => String(c[0])).find(u => u.startsWith('/api/search/annotations'))!
    expect(new URL(searchCall, 'http://x').searchParams.get('sources')).toBe('enzyme')
    await user.click(await screen.findByRole('button', { name: /5\.6\.2/ }))
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('5.6.2 Enzymes altering nucleic acid conformation')
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Sub-subclass')
    expect([...rankSelect().options].map(o => o.value)).toEqual(['ec'])
    await waitFor(() => expect(lastSummaryUrl().searchParams.get('parent')).toBe('5.6.2'))
    expect(lastSummaryUrl().searchParams.get('rank')).toBe('ec')
  })

  it('browses the enzyme tree and starts from the node clicked', async () => {
    enzymeFetch()
    const user = userEvent.setup()
    render(<BulkDownloadPanel />)
    await switchToEnzyme(user)
    await user.click(screen.getByRole('button', { name: 'Browse tree' }))
    await user.click(await screen.findByRole('button', { name: 'Isomerases' }))
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('5 Isomerases')
    await waitFor(() => expect(lastSummaryUrl().searchParams.get('parent')).toBe('5'))
    expect(lastSummaryUrl().searchParams.get('rank')).toBe('subclass')
  })

  it('explains that enzyme rows may not add up; taxonomy does not show that note', async () => {
    enzymeFetch()
    const user = userEvent.setup()
    render(<BulkDownloadPanel />)
    expect(screen.queryByTestId('bulk-source-note')).toBeNull()
    await switchToEnzyme(user)
    expect(screen.getByTestId('bulk-source-note')).toHaveTextContent(/may not add up/i)
  })

  it('a taxonomy handoff switches back to taxonomy', async () => {
    enzymeFetch()
    const user = userEvent.setup()
    const { rerender } = render(<BulkDownloadPanel />)
    await switchToEnzyme(user)
    rerender(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('taxonomy')
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Gammaproteobacteria')
  })
})

describe('BulkDownloadPanel — also include the starting term', () => {
  it('is only offered once a start is chosen', () => {
    render(<BulkDownloadPanel />)
    expect(screen.queryByLabelText(/Also include the starting/)).toBeNull()
  })

  it('adds include_parent to the summary and the download, and is off by default', async () => {
    const user = userEvent.setup()
    render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    const box = screen.getByLabelText(/Also include the starting/) as HTMLInputElement
    expect(box.checked).toBe(false)
    await waitFor(() => expect(lastSummaryUrl().searchParams.has('include_parent')).toBe(false))
    await user.click(box)
    await waitFor(() => expect(lastSummaryUrl().searchParams.get('include_parent')).toBe('true'))
    const href = new URL(screen.getByRole('link', { name: /Download CSV/ }).getAttribute('href')!, 'http://x')
    expect(href.searchParams.get('include_parent')).toBe('true')
  })
})


describe('canBulkDownloadFrom', () => {
  it('is true only when the source is offered and something is below the term', () => {
    expect(canBulkDownloadFrom('taxonomy', 2)).toBe(true)
    expect(canBulkDownloadFrom('taxonomy', 8)).toBe(false)
    expect(canBulkDownloadFrom('enzyme', 3)).toBe(true)
    expect(canBulkDownloadFrom('enzyme', 4)).toBe(false)
    expect(canBulkDownloadFrom('kegg', 3)).toBe(true)
    expect(canBulkDownloadFrom('kegg', 4)).toBe(false)
    expect(canBulkDownloadFrom('cog', 1)).toBe(true)
    expect(canBulkDownloadFrom('cog', 2)).toBe(false)
    expect(canBulkDownloadFrom('nonsense', 1)).toBe(false)
    expect(canBulkDownloadFrom('enzyme', null)).toBe(false)
  })
})

describe('BulkDownloadPanel — handoff of a non-taxonomy term', () => {
  it('switches to that source and starts from the term', async () => {
    mockFetch.mockResolvedValue(jsonResponse(summary({ taxa: 2, max_rows: 256 })))
    render(<BulkDownloadPanel initialParent={{ lineage: '5.6.2', source: 'enzyme', depth: 3, name: 'Enzymes altering nucleic acid conformation' }} />)
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('enzyme')
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('5.6.2 Enzymes altering nucleic acid conformation')
    await waitFor(() => expect(lastSummaryUrl().searchParams.get('source')).toBe('enzyme'))
    expect(lastSummaryUrl().searchParams.get('parent')).toBe('5.6.2')
    expect(lastSummaryUrl().searchParams.get('rank')).toBe('ec')
  })
})


// ── KEGG: review list and path choices ───────────────────────────────────────

const CARB = '09101'
const REVIEW = {
  terms: [
    {
      annotation_id: 'K00844', name: 'HK; hexokinase [EC:2.7.1.1]', total_paths: 14,
      paths: [
        { parent_id: '00010', parent_name: 'Glycolysis / Gluconeogenesis [PATH:ko00010]', parent_mean_egc: 188665.2,
          lineage_ids: ['09100', CARB, '00010', 'K00844'], lineage_names: ['Metabolism', 'Carbohydrate metabolism', 'Glycolysis / Gluconeogenesis [PATH:ko00010]', 'HK'] },
        { parent_id: '00052', parent_name: 'Galactose metabolism [PATH:ko00052]', parent_mean_egc: 63100,
          lineage_ids: ['09100', CARB, '00052', 'K00844'], lineage_names: ['Metabolism', 'Carbohydrate metabolism', 'Galactose metabolism [PATH:ko00052]', 'HK'] },
      ],
    },
    {
      annotation_id: 'K01810', name: 'GPI; glucose-6-phosphate isomerase', total_paths: 3,
      paths: [
        { parent_id: '00010', parent_name: 'Glycolysis / Gluconeogenesis [PATH:ko00010]', parent_mean_egc: 188665.2,
          lineage_ids: ['09100', CARB, '00010', 'K01810'], lineage_names: ['Metabolism', 'Carbohydrate metabolism', 'Glycolysis / Gluconeogenesis [PATH:ko00010]', 'GPI'] },
        { parent_id: '00030', parent_name: 'Pentose phosphate pathway [PATH:ko00030]', parent_mean_egc: 90000,
          lineage_ids: ['09100', CARB, '00030', 'K01810'], lineage_names: ['Metabolism', 'Carbohydrate metabolism', 'Pentose phosphate pathway [PATH:ko00030]', 'GPI'] },
      ],
    },
  ],
}

function keggFetch(multi = 2) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/series/export/review')) return jsonResponse(REVIEW)
    if (url.startsWith('/api/search/annotations')) {
      return jsonResponse({ data: [{ annotation_id: CARB, name: 'Carbohydrate metabolism', depth: 2 }], total: 1 })
    }
    return jsonResponse({ ...summary({ taxa: 716, max_rows: 1000 * 128 }), multi_path_terms: multi })
  })
}

function renderKeggKos() {
  render(<BulkDownloadPanel initialParent={{ lineage: CARB, source: 'kegg', depth: 2, name: 'Carbohydrate metabolism' }} />)
}

async function chooseKo(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(rankSelect(), 'ko')
}

function postCalls(path: string) {
  return mockFetch.mock.calls.filter(c => String(c[0]).startsWith(path) && (c[1] as RequestInit | undefined)?.method === 'POST')
}

describe('levelOptionsBelow — KEGG', () => {
  it('lists the KEGG levels', () => {
    expect(levelOptionsBelow('kegg', 0).map(o => [o.value, o.label])).toEqual([
      ['category', 'Category'], ['subcategory', 'Subcategory'], ['pathway', 'Pathway / BRITE table'], ['ko', 'KO'],
    ])
    expect(levelOptionsBelow('kegg', 2).map(o => o.value)).toEqual(['pathway', 'ko'])
  })
})

describe('BulkDownloadPanel — KEGG review list', () => {
  it('says how many KOs are in more than one pathway, only when there are some', async () => {
    keggFetch(194)
    const user = userEvent.setup()
    renderKeggKos()
    await chooseKo(user)
    expect(await screen.findByTestId('bulk-review-line')).toHaveTextContent('194 of these KOs are in more than one pathway here')
  })

  it('has no review line when nothing needs review', async () => {
    keggFetch(0)
    renderKeggKos()
    await screen.findByTestId('bulk-size')
    expect(screen.queryByTestId('bulk-review-line')).toBeNull()
  })

  it('opens the list, with the note about what the abundance means', async () => {
    keggFetch()
    const user = userEvent.setup()
    renderKeggKos()
    await chooseKo(user)
    await user.click(await screen.findByRole('button', { name: /Review/ }))
    const reviewUrl = new URL(String(mockFetch.mock.calls.map(c => c[0]).find(u => String(u).startsWith('/api/series/export/review'))), 'http://x')
    expect(Object.fromEntries(reviewUrl.searchParams)).toEqual({ source: 'kegg', parent: CARB, rank: 'ko' })
    expect(await screen.findByText(/K00844/)).toBeInTheDocument()
    expect(screen.getByTestId('bulk-review-note')).toHaveTextContent(/describes the pathway as a whole, not where this KO is active/)
    expect(screen.getByTestId('bulk-review-K00844')).toHaveTextContent('2 of 2 paths')
    expect(screen.getByTestId('bulk-review-K00844')).toHaveTextContent('12 more outside your start')
  })

  it('lists each KO\'s pathways in the order given (most abundant first) with their mean EGC', async () => {
    keggFetch()
    const user = userEvent.setup()
    renderKeggKos()
    await chooseKo(user)
    await user.click(await screen.findByRole('button', { name: /Review/ }))
    await user.click(await screen.findByRole('button', { name: /K00844/ }))
    const boxes = screen.getAllByRole('checkbox', { name: /K00844/ })
    expect(boxes.map(b => b.getAttribute('aria-label'))).toEqual([
      'K00844 in Glycolysis / Gluconeogenesis [PATH:ko00010]',
      'K00844 in Galactose metabolism [PATH:ko00052]',
    ])
    expect(boxes.every(b => (b as HTMLInputElement).checked)).toBe(true)
    expect(screen.getByTestId('bulk-review-K00844')).toHaveTextContent('188,665')
  })

  it('unticking a pathway sends it with the size request and turns the download into a form post', async () => {
    keggFetch()
    const user = userEvent.setup()
    renderKeggKos()
    await chooseKo(user)
    await user.click(await screen.findByRole('button', { name: /Review/ }))
    await user.click(await screen.findByRole('button', { name: /K00844/ }))
    await user.click(screen.getByRole('checkbox', { name: 'K00844 in Galactose metabolism [PATH:ko00052]' }))

    await waitFor(() => expect(postCalls('/api/series/export/summary').length).toBeGreaterThan(0))
    const [url, init] = postCalls('/api/series/export/summary').at(-1)!
    expect(new URL(String(url), 'http://x').searchParams.get('rank')).toBe('ko')
    expect((init as RequestInit).headers).toEqual({ 'Content-Type': 'text/plain' })
    expect(String((init as RequestInit).body)).toBe('selection={"exclude":[["K00844","00052"]]}')

    expect(screen.getByTestId('bulk-review-line')).toHaveTextContent('1 path unticked')
    expect(screen.getByTestId('bulk-review-K00844')).toHaveTextContent('1 of 2 paths')
    expect(screen.queryByRole('link', { name: /Download CSV/ })).toBeNull()
    const form = screen.getByTestId('bulk-download-form') as HTMLFormElement
    expect(form.getAttribute('method')).toBe('post')
    expect(form.getAttribute('enctype')).toBe('text/plain')
    expect(Object.fromEntries(new URL(form.getAttribute('action')!, 'http://x').searchParams)).toEqual({ source: 'kegg', rank: 'ko', parent: CARB })
    expect((form.querySelector('input[name="selection"]') as HTMLInputElement).value).toBe('{"exclude":[["K00844","00052"]]}')
  })

  it('None unticks every pathway of a KO and All ticks them again', async () => {
    keggFetch()
    const user = userEvent.setup()
    renderKeggKos()
    await chooseKo(user)
    await user.click(await screen.findByRole('button', { name: /Review/ }))
    const row = await screen.findByTestId('bulk-review-K00844')
    await user.click(within(row).getByRole('button', { name: 'None' }))
    expect(row).toHaveTextContent('0 of 2 paths')
    await user.click(within(row).getByRole('button', { name: 'All' }))
    expect(row).toHaveTextContent('2 of 2 paths')
    expect(screen.getByRole('link', { name: /Download CSV/ })).toBeInTheDocument()
  })

  it('the filter narrows the list by id or name', async () => {
    keggFetch()
    const user = userEvent.setup()
    renderKeggKos()
    await chooseKo(user)
    await user.click(await screen.findByRole('button', { name: /Review/ }))
    await screen.findByTestId('bulk-review-K00844')
    await user.type(screen.getByPlaceholderText(/Filter KOs/), 'isomerase')
    expect(screen.queryByTestId('bulk-review-K00844')).toBeNull()
    expect(screen.getByTestId('bulk-review-K01810')).toBeInTheDocument()
  })

  it('changing the level clears the choices', async () => {
    keggFetch()
    const user = userEvent.setup()
    renderKeggKos()
    await chooseKo(user)
    await user.click(await screen.findByRole('button', { name: /Review/ }))
    const row = await screen.findByTestId('bulk-review-K00844')
    await user.click(within(row).getByRole('button', { name: 'None' }))
    expect(screen.getByTestId('bulk-download-form')).toBeInTheDocument()
    await user.selectOptions(rankSelect(), 'pathway')
    await user.selectOptions(rankSelect(), 'ko')
    expect(screen.queryByTestId('bulk-download-form')).toBeNull()
  })

  it('explains that KEGG rows may not add up', async () => {
    keggFetch()
    renderKeggKos()
    expect(screen.getByTestId('bulk-source-note')).toHaveTextContent(/counts in each of them/)
  })
})

// ── COG ──────────────────────────────────────────────────────────────────────

describe('levelOptionsBelow — COG', () => {
  it('lists the COG levels', () => {
    expect(levelOptionsBelow('cog', 0).map(o => [o.value, o.label])).toEqual([['category', 'Category'], ['cog', 'COG']])
    expect(levelOptionsBelow('cog', 1).map(o => o.value)).toEqual(['cog'])
  })
})

describe('BulkDownloadPanel — COG', () => {
  const COG_REVIEW = {
    terms: [{
      annotation_id: 'COG0028', name: 'Acetolactate synthase large subunit', total_paths: 2,
      paths: [
        { parent_id: 'E', parent_name: 'Amino acid transport and metabolism', parent_mean_egc: 900000,
          lineage_ids: ['E', 'COG0028'], lineage_names: ['Amino acid transport and metabolism', 'Acetolactate synthase large subunit'] },
        { parent_id: 'H', parent_name: 'Coenzyme transport and metabolism', parent_mean_egc: 300000,
          lineage_ids: ['H', 'COG0028'], lineage_names: ['Coenzyme transport and metabolism', 'Acetolactate synthase large subunit'] },
      ],
    }],
  }

  function cogFetch() {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/series/export/review')) return jsonResponse(COG_REVIEW)
      return jsonResponse({ ...summary({ taxa: 4612, max_rows: 4952 * 128 }), multi_path_terms: 340 })
    })
  }

  it('whole dataset to COGs: the review line and list talk about categories', async () => {
    cogFetch()
    const user = userEvent.setup()
    render(<BulkDownloadPanel />)
    await user.selectOptions(screen.getByLabelText('Source'), 'cog')
    await user.selectOptions(rankSelect(), 'cog')
    expect(await screen.findByTestId('bulk-review-line')).toHaveTextContent('340 of these COGs are in more than one category here')
    await user.click(screen.getByRole('button', { name: /Review/ }))
    expect(await screen.findByTestId('bulk-review-note')).toHaveTextContent(/describes the category as a whole, not where this COG is active/)
    expect(screen.getByTestId('bulk-review-note')).toHaveTextContent(/^Each COG's categories are sorted by the category's mean EGC/)
    expect(screen.getByPlaceholderText(/Filter COGs/)).toBeInTheDocument()
    expect(screen.getByTestId('bulk-review-COG0028')).toHaveTextContent('2 of 2 paths')
  })

  it('explains that COG rows can add up to more than the category', async () => {
    cogFetch()
    const user = userEvent.setup()
    render(<BulkDownloadPanel />)
    await user.selectOptions(screen.getByLabelText('Source'), 'cog')
    expect(screen.getByTestId('bulk-source-note')).toHaveTextContent(/more than one COG counts under each/)
  })
})


// ── Final checks: empty date range, Excel warning ───────────────────────────

describe('BulkDownloadPanel — a date range with no samples', () => {
  it('says so and does not offer a header-only file', async () => {
    mockFetch.mockResolvedValue(jsonResponse(summary({ taxa: 76, samples: 0, max_rows: 0 })))
    render(<BulkDownloadPanel initialParent={{ lineage: GAMMA }} />)
    expect(await screen.findByTestId('bulk-size')).toHaveTextContent('No samples in this date range.')
    expect(screen.queryByRole('link', { name: /Download CSV/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled()
  })
})

describe('BulkDownloadPanel — column help warns about Excel and IDs', () => {
  async function columnHelp(user: ReturnType<typeof userEvent.setup>) {
    const helpButtons = screen.getAllByRole('button', { name: '?' })
    await user.click(helpButtons[helpButtons.length - 1])
    return document.body.textContent ?? ''
  }

  it('for KEGG and Enzyme, whose IDs Excel turns into numbers', async () => {
    for (const source of ['kegg', 'enzyme']) {
      mockFetch.mockResolvedValue(jsonResponse(summary()))
      const user = userEvent.setup()
      const { unmount } = render(<BulkDownloadPanel />)
      await user.selectOptions(screen.getByLabelText('Source'), source)
      expect(await columnHelp(user)).toMatch(/Excel can turn IDs such as 00010 or 1\.10 into numbers/)
      unmount()
    }
  })

  it('not for taxonomy', async () => {
    mockFetch.mockResolvedValue(jsonResponse(summary()))
    const user = userEvent.setup()
    render(<BulkDownloadPanel />)
    expect(await columnHelp(user)).not.toMatch(/Excel can turn IDs/)
  })
})

describe('BulkDownloadPanel — late search answers', () => {
  const BACILLUS = 'Bacteria;Firmicutes;Bacilli;Bacillales;Bacillaceae;Bacillus'
  const BACTEROIDES = 'Bacteria;Bacteroidetes;Bacteroidia;Bacteroidales;Bacteroidaceae;Bacteroides'

  // Each search request waits until the test answers it, in any order.
  function deferSearches() {
    const pending: ((rows: object[]) => void)[] = []
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith('/api/search/annotations')) {
        return new Promise(resolve => pending.push(rows => resolve(jsonResponse({ data: rows, total: rows.length }))))
      }
      return Promise.resolve(jsonResponse(summary()))
    })
    return pending
  }

  it('drops a search answer that arrives after the source changed', async () => {
    const user = userEvent.setup()
    const pending = deferSearches()
    render(<BulkDownloadPanel />)
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await user.type(screen.getByPlaceholderText(/Search for a taxon/), 'Bacillus{Enter}')
    await waitFor(() => expect(pending).toHaveLength(1))
    await user.selectOptions(screen.getByLabelText('Source'), 'kegg')
    pending[0]([{ annotation_id: BACILLUS, name: 'Bacillus', depth: 6 }])
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByRole('button', { name: /Bacillus/ })).toBeNull()
  })

  it('shows the latest search when an earlier one answers last', async () => {
    const user = userEvent.setup()
    const pending = deferSearches()
    render(<BulkDownloadPanel />)
    await user.click(screen.getByRole('button', { name: 'Search' }))
    const input = screen.getByPlaceholderText(/Search for a taxon/)
    await user.type(input, 'Bac{Enter}')
    await user.clear(input)
    await user.type(input, 'Bacillus{Enter}')
    await waitFor(() => expect(pending).toHaveLength(2))
    pending[1]([{ annotation_id: BACILLUS, name: 'Bacillus', depth: 6 }])
    expect(await screen.findByRole('button', { name: /Bacillus/ })).toBeInTheDocument()
    pending[0]([{ annotation_id: BACTEROIDES, name: 'Bacteroides', depth: 6 }])
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByRole('button', { name: /Bacteroides/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Bacillus/ })).toBeInTheDocument()
  })
})
