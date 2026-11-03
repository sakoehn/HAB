import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ComparePage } from '/home/mriffle/dev/sophie-metatrace/HAB/frontend/src/pages/ComparePage'
import { makeDefaultCompareState } from '/home/mriffle/dev/sophie-metatrace/HAB/frontend/src/pages/compareState'
import type { CompareState, SharedAnnotation } from '/home/mriffle/dev/sophie-metatrace/HAB/frontend/src/types'
import { nextColorForSource, resetSourceCounters } from '/home/mriffle/dev/sophie-metatrace/HAB/frontend/src/constants'
import { homonymHints } from '/home/mriffle/dev/sophie-metatrace/HAB/frontend/src/utils/taxonomy'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const R1 = { annotation_id: 'K02014', source: 'kegg', name: 'TonB-dep receptor', parent: null, mean_egc: 5000, max_egc: 12000, sample_count: 128, value: null, timepoint: null, sample: '' }
const R2 = { annotation_id: 'K00001', source: 'kegg', name: 'Alcohol dehydrogenase', parent: null, mean_egc: 2000, max_egc: 5000, sample_count: 64, value: null, timepoint: null, sample: '' }
const R3 = { annotation_id: 'K00010', source: 'kegg', name: 'iolG', parent: null, mean_egc: 1000, max_egc: 2000, sample_count: 64, value: null, timepoint: null, sample: '' }
const SEARCH = { data: [R1, R2, R3], total: 3 }
const SERIES = {
  data: Array.from({ length: 5 }, (_, i) => ({
    annotation_id: 'K02014', source: 'kegg', name: 'x', sample: `s${i}`,
    timepoint: { taxon_oid: `s${i}`, timepoint: String(i), datetime: `5/${i + 1}/21 8:00` },
    value: { egc: 1000 + i * 100, norm_egc: 0.0001 },
  })),
}

function setupMocks() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/search/annotations')) return Promise.resolve({ ok: true, status: 200, json: async () => SEARCH })
    if (url.includes('/api/series/annotations')) return Promise.resolve({ ok: true, status: 200, json: async () => SERIES })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
  })
}

function Managed({ initialState, initialAnnotations = [] }: { initialState?: Partial<CompareState>; initialAnnotations?: SharedAnnotation[] }) {
  const [state, setStateRaw] = React.useState<CompareState>({ ...makeDefaultCompareState(), ...initialState })
  const [pending, setPending] = React.useState<SharedAnnotation[]>(initialAnnotations)
  const setState = React.useCallback((u: (p: CompareState) => CompareState) => setStateRaw(u), [])
  return (
    <ComparePage
      state={state} setState={setState}
      initialAnnotations={pending} onConsumed={() => setPending([])}
      onReset={() => setStateRaw(makeDefaultCompareState())}
    />
  )
}

const chip = (label: string) => Array.from(document.querySelectorAll('.compare-chip')).find(c => c.querySelector(`span[title="${label}"]`)) as HTMLElement | undefined
const dot  = (label: string) => (chip(label)!.querySelector('.chip-color') as HTMLElement).style.background

beforeEach(() => { setupMocks(); resetSourceCounters() })
afterEach(() => { vi.clearAllMocks() })

const EXISTING = { id: 'existing-1', annotationId: 'K00001', source: 'kegg', name: 'Alcohol dehydrogenase', data: SERIES.data, status: 'ok' as const, color: '#000000' }

describe('Compare: "Select top N" then "Add N selected" with an already-open row', () => {
  it('does not open the same annotation twice', async () => {
    render(<Managed initialState={{ entries: [EXISTING] }} />)
    await userEvent.type(await screen.findByPlaceholderText(/search annotation id or name/i), 'K000')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => screen.getByText('TonB-dep receptor'))
    // K00001 is already open: its row is dimmed/"added" and its own checkbox disabled.
    expect(screen.getByText('added')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText(/select top 3/i))
    const addBtn = await screen.findByRole('button', { name: /add \d selected/i })
    await userEvent.click(addBtn)
    await waitFor(() => expect(chip('K02014')).toBeTruthy())
    const k00001Chips = Array.from(document.querySelectorAll('.compare-chip span[title="K00001"]')).length
    expect(k00001Chips).toBe(1)
  })
})

describe('Compare: colours after an Analyze handoff', () => {
  it('a handed-over series does not reuse the colour of a series already on the page', async () => {
    // The page already holds a kegg entry that was coloured by nextColorForSource (counter now 1).
    const existingColor = nextColorForSource('kegg')
    render(<Managed initialState={{ entries: [{ ...EXISTING, color: existingColor }] }}
                    initialAnnotations={[{ kind: 'single', annotationId: 'K02014', source: 'kegg', name: 'TonB-dep receptor' }]} />)
    await waitFor(() => expect(chip('K02014')).toBeTruthy())
    expect(dot('K02014')).not.toBe(dot('K00001'))
  })
})

describe('Compare: a handed-over group with the same label as an open group', () => {
  const g = (id: string, label: string, members: string[]) => ({
    id, annotationId: label, source: 'kegg', name: label, data: SERIES.data, status: 'ok' as const, color: '#56B4E9',
    isGrouped: true, membersExpanded: false,
    members: members.map(m => ({ annotationId: m, source: 'kegg', data: SERIES.data, status: 'ok' as const })),
  })
  it('is either added or named in the skipped notice, never dropped silently', async () => {
    render(<Managed initialState={{ entries: [g('g1', 'iron (2)', ['K02014', 'K00001'])] }}
                    initialAnnotations={[{ kind: 'group', label: 'iron (2)', members: [{ annotationId: 'K00010', source: 'kegg' }, { annotationId: 'K00020', source: 'kegg' }] }]} />)
    await waitFor(() => expect(chip('iron (2)')).toBeTruthy())
    await new Promise(r => setTimeout(r, 200))
    const groupChips = document.querySelectorAll('.compare-chip span[title="iron (2)"]').length
    const notice = screen.queryByTestId('compare-handoff-skipped')
    expect(groupChips === 2 || notice !== null).toBe(true)
  })
})

describe('Compare: "Clear Page" clears the handoff notice', () => {
  it('the "not added" notice does not survive a reset', async () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ ...EXISTING, id: `e${i}`, annotationId: `K1000${i}` }))
    render(<Managed initialState={{ entries: four }}
                    initialAnnotations={[{ kind: 'single', annotationId: 'K02014', source: 'kegg', name: 'x' }]} />)
    await screen.findByTestId('compare-handoff-skipped')
    await userEvent.click(screen.getByRole('button', { name: /clear page/i }))
    await waitFor(() => expect(document.querySelectorAll('.compare-chip').length).toBe(0))
    expect(screen.queryByTestId('compare-handoff-skipped')).not.toBeInTheDocument()
  })
})

describe('homonymHints: same name at different depths', () => {
  it('gives the two taxa different hints', () => {
    const a = 'Bacteria;Proteobacteria;Bosea'
    const b = 'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Bosea'
    const h = homonymHints([a, b])
    expect(h.get(a)).not.toBe(h.get(b))
  })
})
