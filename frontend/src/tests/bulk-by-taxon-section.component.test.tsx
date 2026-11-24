/**
 * bulk-by-taxon-section.component.test.tsx
 * ========================================
 * Tests for BulkByTaxonSection (components/download/BulkByTaxonSection.tsx)
 * and its helpers in utils/bulkDownload.ts: the Bulk Download section's
 * "KEGG by taxon" form -- paste KO ids, pick a rank and format, see the
 * size, download each KO's EGC split by taxon from
 * /api/series/export/by-taxon.
 *
 * Coverage
 * --------
 *   parseKoList / buildByTaxonQuery / koSelectionJson (pure helpers)
 *   nothing is asked for until a KO is typed
 *   the summary request: KOs in the body, rank/format/metric/dates in the URL
 *   size line, unknown KOs, none known, over the limit, error
 *   the download form posts the same KOs and query
 *   value picker only for wide
 *   column help for long and wide
 *   a slower, superseded summary response is ignored
 *
 * Run: npx vitest run src/tests/bulk-by-taxon-section.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { BulkByTaxonSection } from '../components/download/BulkByTaxonSection'
import { buildByTaxonQuery, koSelectionJson, parseKoList } from '../utils/bulkDownload'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => data }
}

type Summary = { kos: number; unknown_kos: string[]; rank: string; samples: number; genes: number; max_genes: number }

function summary(over: Partial<Summary> = {}): Summary {
  return { kos: 2, unknown_kos: [], rank: 'genus', samples: 128, genes: 543210, max_genes: 5000000, ...over }
}

function summaryCalls(): { url: URL; body: string }[] {
  return mockFetch.mock.calls
    .map(c => ({ url: new URL(String(c[0]), 'http://x'), body: String(c[1]?.body ?? '') }))
    .filter(c => c.url.pathname === '/api/series/export/by-taxon/summary')
}

function lastSummary() {
  const calls = summaryCalls()
  return calls[calls.length - 1]
}

function koBox() {
  return screen.getByLabelText('KOs') as HTMLTextAreaElement
}

async function typeKos(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(koBox(), text)
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue(jsonResponse(summary()))
})

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('parseKoList', () => {
  it('splits on commas, semicolons, spaces and new lines', () => {
    expect(parseKoList('K02014, K00525;K01915\nK00001  K00002')).toEqual(['K02014', 'K00525', 'K01915', 'K00001', 'K00002'])
  })

  it('drops the KO: prefix, upper-cases and removes duplicates', () => {
    expect(parseKoList('ko:k02014 KO:K02014 k00525')).toEqual(['K02014', 'K00525'])
  })

  it('gives nothing for blank text', () => {
    expect(parseKoList('  ,\n ')).toEqual([])
  })
})

describe('buildByTaxonQuery', () => {
  it('sends the metric only for wide, and dates only when set', () => {
    const long = new URLSearchParams(buildByTaxonQuery({ rank: 'genus', format: 'long', metric: 'norm_egc', dateFrom: '', dateTo: '' }))
    expect(Object.fromEntries(long)).toEqual({ rank: 'genus', format: 'long' })
    const wide = new URLSearchParams(buildByTaxonQuery({ rank: 'phylum', format: 'wide', metric: 'norm_egc', dateFrom: '2021-06-01', dateTo: '2021-06-05' }))
    expect(Object.fromEntries(wide)).toEqual({ rank: 'phylum', format: 'wide', metric: 'norm_egc', date_from: '2021-06-01', date_to: '2021-06-05' })
  })
})

describe('koSelectionJson', () => {
  it('is the {"kos": [...]} body the route reads', () => {
    expect(JSON.parse(koSelectionJson(['K02014', 'K00525']))).toEqual({ kos: ['K02014', 'K00525'] })
  })
})

// ── Component ────────────────────────────────────────────────────────────────

describe('BulkByTaxonSection', () => {
  it('asks for nothing and cannot download until a KO is typed', () => {
    render(<BulkByTaxonSection />)
    expect(summaryCalls()).toHaveLength(0)
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled()
  })

  it('sends the KOs in the body and the choices in the URL, genus and long by default', async () => {
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    await typeKos(user, 'K02014, ko:k00525')
    await waitFor(() => expect(lastSummary()).toBeDefined())
    const { url, body } = lastSummary()
    expect(Object.fromEntries(url.searchParams)).toEqual({ rank: 'genus', format: 'long' })
    expect(body).toBe(`selection=${koSelectionJson(['K02014', 'K00525'])}`)
  })

  it('shows the size and posts the same KOs and query to the download', async () => {
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    await typeKos(user, 'K02014 K00525')
    expect(await screen.findByTestId('bytaxon-size')).toHaveTextContent('2 KOs × 128 timepoints · 543,210 gene records')
    const form = screen.getByTestId('bytaxon-download-form') as HTMLFormElement
    const action = new URL(form.getAttribute('action')!, 'http://x')
    expect(action.pathname).toBe('/api/series/export/by-taxon')
    expect(action.search).toBe(lastSummary().url.search)
    expect(form.getAttribute('method')).toBe('post')
    expect(form.getAttribute('enctype')).toBe('text/plain')
    expect((form.querySelector('input[name="selection"]') as HTMLInputElement).value).toBe(koSelectionJson(['K02014', 'K00525']))
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeEnabled()
  })

  it('names KOs that are not in the data', async () => {
    mockFetch.mockResolvedValue(jsonResponse(summary({ kos: 1, unknown_kos: ['K99999'] })))
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    await typeKos(user, 'K02014 K99999')
    expect(await screen.findByTestId('bytaxon-unknown')).toHaveTextContent('Not in the data, left out: K99999')
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeEnabled()
  })

  it('cannot download when none of the KOs are in the data', async () => {
    mockFetch.mockResolvedValue(jsonResponse(summary({ kos: 0, unknown_kos: ['K99999'], genes: 0 })))
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    await typeKos(user, 'K99999')
    expect(await screen.findByTestId('bytaxon-size')).toHaveTextContent('None of these KOs are in the data.')
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled()
  })

  it('cannot download over the gene-record limit, and says so', async () => {
    mockFetch.mockResolvedValue(jsonResponse(summary({ genes: 6000000 })))
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    await typeKos(user, 'K02014')
    expect(await screen.findByTestId('bytaxon-too-big')).toHaveTextContent('over the 5,000,000 limit')
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled()
  })

  it('shows an error when the size cannot be worked out', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, false))
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    await typeKos(user, 'K02014')
    expect(await screen.findByTestId('bytaxon-error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled()
  })

  it('offers every rank from domain to strain', () => {
    render(<BulkByTaxonSection />)
    const ranks = [...(screen.getByLabelText('Group by') as HTMLSelectElement).options].map(o => o.value)
    expect(ranks).toEqual(['domain', 'phylum', 'class', 'order', 'family', 'genus', 'species', 'strain'])
  })

  it('offers the value picker only for wide, and sends it', async () => {
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    expect(screen.queryByLabelText('Value')).toBeNull()
    await user.click(screen.getByLabelText('Wide'))
    await user.selectOptions(screen.getByLabelText('Value'), 'norm_egc')
    await user.selectOptions(screen.getByLabelText('Group by'), 'phylum')
    await typeKos(user, 'K02014')
    await waitFor(() => expect(lastSummary()?.url.searchParams.get('metric')).toBe('norm_egc'))
    expect(Object.fromEntries(lastSummary().url.searchParams)).toEqual({ rank: 'phylum', format: 'wide', metric: 'norm_egc' })
  })

  it('lists the columns of the chosen format', async () => {
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    await user.click(screen.getByRole('button', { name: '?' }))
    expect(document.body.textContent).toMatch(
      /Columns: ko, ko_name, taxon, rank, lineage, sample, date, time, egc, norm_egc, detected/,
    )
    await user.click(screen.getByRole('button', { name: '?' }))
    await user.click(screen.getByLabelText('Wide'))
    await user.click(screen.getByRole('button', { name: '?' }))
    expect(document.body.textContent).toMatch(/Columns: ko, ko_name, taxon, rank, lineage, then one column per timepoint/)
  })

  it('hides the old size while a changed KO list is being counted', async () => {
    const answers: ((s: Summary) => void)[] = []
    mockFetch.mockImplementation(() => new Promise(resolve => answers.push(s => resolve(jsonResponse(s)))))
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    await typeKos(user, 'K02014')
    await waitFor(() => expect(answers).toHaveLength(1))
    answers[0](summary({ kos: 1, genes: 111 }))
    expect(await screen.findByTestId('bytaxon-size')).toHaveTextContent('111 gene records')
    await typeKos(user, ' K00525')
    expect(screen.queryByTestId('bytaxon-size')).toBeNull()
    expect(screen.getByText('Counting…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled()
  })

  it('ignores a slower response for KOs that have since changed', async () => {
    const answers: ((s: Summary) => void)[] = []
    mockFetch.mockImplementation(() => new Promise(resolve => answers.push(s => resolve(jsonResponse(s)))))
    const user = userEvent.setup()
    render(<BulkByTaxonSection />)
    await typeKos(user, 'K02014')
    await waitFor(() => expect(answers).toHaveLength(1))
    await typeKos(user, ' K00525')
    await waitFor(() => expect(answers).toHaveLength(2))
    answers[1](summary({ kos: 2, genes: 222 }))
    answers[0](summary({ kos: 1, genes: 111 }))
    expect(await screen.findByTestId('bytaxon-size')).toHaveTextContent('222 gene records')
    await new Promise(r => setTimeout(r, 50))
    expect(screen.getByTestId('bytaxon-size')).toHaveTextContent('222 gene records')
  })
})
