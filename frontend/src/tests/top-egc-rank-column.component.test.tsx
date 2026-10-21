/**
 * top-egc-rank-column.component.test.tsx
 * ========================================
 * Top EGC Annotations table (ExplorePage): every row's rank is visible in its
 * own Rank column -- the same per-source names the Lookup card's Depth row
 * uses (utils/stats depthLabel) -- the Rank filter pills use those same
 * names instead of "Level N", and the CSV export carries readable `rank` and
 * `group` columns (exactly what the table shows) alongside the raw
 * depth/parent codes, so a download is understandable on its own.
 *
 * downloadCsv is intercepted (vi.mock of utils/api) so the exported rows
 * themselves can be asserted, not just the filename.
 *
 * Run: npx vitest run src/tests/top-egc-rank-column.component.test.tsx
 */
import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const downloadCsv = vi.fn()
vi.mock('../utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/api')>()),
  downloadCsv: (...args: unknown[]) => downloadCsv(...args),
}))

import { ExplorePage } from '../pages/ExplorePage'
import { makeDefaultExploreState, type ExploreState } from '../pages/exploreState'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data })

const ROWS: Record<string, object[]> = {
  cog: [
    { annotation_id: 'E', name: 'Amino acid transport and metabolism', parent: null, depth: 1, mean_egc: 900, max_egc: 1000, sample_count: 128 },
    { annotation_id: 'COG1473', name: 'Metal-dependent amidase', parent: 'R', depth: 2, mean_egc: 100, max_egc: 200, sample_count: 128 },
  ],
  kegg: [
    { annotation_id: '09100', name: 'Metabolism', parent: null, depth: 1, mean_egc: 900, max_egc: 1000, sample_count: 128 },
    { annotation_id: 'K00134', name: 'GAPDH', parent: '03019', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
  ],
  enzyme: [
    { annotation_id: '1.14.15', name: 'With reduced iron-sulfur protein', parent: '1.14', depth: 3, mean_egc: 100, max_egc: 200, sample_count: 128 },
  ],
  taxonomy: [
    { annotation_id: 'Bacteria;Bacteroidetes;Flavobacteriia;Flavobacteriales;Flavobacteriaceae;Ulvibacter;Ulvibacter antarcticus', name: 'Ulvibacter antarcticus', parent: 'Bacteria;Bacteroidetes;Flavobacteriia;Flavobacteriales;Flavobacteriaceae;Ulvibacter', depth: 7, mean_egc: 100, max_egc: 200, sample_count: 128 },
  ],
}

beforeEach(() => {
  downloadCsv.mockReset()
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/annotations/top')) {
      const src = /source=(\w+)/.exec(url)![1]
      return Promise.resolve(json({ data: ROWS[src], sample_count: 128 }))
    }
    if (url.includes('/api/kegg/parents')) {
      return Promise.resolve(json({ parents: {
        K00134: [
          { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis' },
          { annotation_id: '03019', name: 'Messenger RNA biogenesis' },
        ],
      } }))
    }
    return Promise.resolve(json({}))
  })
})

function Harness({ initial }: { initial: Partial<ExploreState> }) {
  const [state, setState] = useState<ExploreState>({ ...makeDefaultExploreState(), ...initial })
  return (
    <ExplorePage
      state={state}
      setState={updater => setState(updater)}
      resetKey={0}
      dataDateRange={null}
      indexReady
      onSendToAnalyze={() => {}}
      onGoScaffoldExplore={() => {}}
      onReset={() => {}}
    />
  )
}

async function loadTop(source: string) {
  const user = userEvent.setup()
  render(<Harness initial={{ openSection: 'top-egc', source }} />)
  await user.click(screen.getByRole('button', { name: /^Load$/i }))
  await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1))
  return user
}

function cellText(rowIdText: string, header: string): string {
  const table = screen.getAllByRole('table').find(t => within(t).queryByText(header))!
  const headers = within(table).getAllByRole('columnheader').map(h => h.textContent?.trim())
  const col = headers.findIndex(h => h?.startsWith(header))
  const row = within(table).getAllByRole('row').find(r => within(r).queryByText(rowIdText))!
  return within(row).getAllByRole('cell')[col].textContent?.trim() ?? ''
}

describe('Top EGC — Rank column', () => {
  it('cog rows show category / leaf (COG)', async () => {
    await loadTop('cog')
    expect(cellText('E', 'Rank')).toBe('category')
    expect(cellText('COG1473', 'Rank')).toBe('leaf (COG)')
  })

  it('kegg rows show pathway class / leaf (KO)', async () => {
    await loadTop('kegg')
    await waitFor(() => expect(cellText('K00134', 'Rank')).toBe('leaf (KO)'))
    expect(cellText('09100', 'Rank')).toBe('pathway class')
  })

  it('enzyme rows show sub-subclass', async () => {
    await loadTop('enzyme')
    expect(cellText('1.14.15', 'Rank')).toBe('sub-subclass')
  })

  it('taxonomy rows show the taxonomic rank', async () => {
    await loadTop('taxonomy')
    expect(cellText('Ulvibacter antarcticus', 'Rank')).toBe('Species')
  })
})

describe('Top EGC — Rank filter pills use the same names', () => {
  it('kegg pills read "pathway class" / "leaf (KO)", not "Level N", and still filter', async () => {
    const user = await loadTop('kegg')
    await waitFor(() => expect(screen.getByText('K00134')).toBeInTheDocument())
    expect(screen.queryByText('Level 1')).not.toBeInTheDocument()
    const pills = screen.getAllByRole('button').filter(b => b.className.includes('al-source-pill'))
    const leafPill = pills.find(b => b.textContent === 'leaf (KO)')!
    expect(pills.map(b => b.textContent)).toContain('pathway class')
    await user.click(leafPill)
    expect(screen.queryByText('09100')).not.toBeInTheDocument()
    expect(screen.getByText('K00134')).toBeInTheDocument()
  })
})

describe('Top EGC — CSV has readable rank and group columns', () => {
  it('cog: group is the full category name, rank is readable, raw depth/parent kept', async () => {
    const user = await loadTop('cog')
    await user.click(screen.getByRole('button', { name: /CSV/ }))
    const rows = downloadCsv.mock.calls[0][0] as Record<string, unknown>[]
    const leaf = rows.find(r => r.annotation_id === 'COG1473')!
    expect(leaf).toMatchObject({
      rank: 'leaf (COG)', group: 'General function prediction only', depth: 2, parent: 'R',
    })
    expect(rows.find(r => r.annotation_id === 'E')).toMatchObject({ rank: 'category', group: '' })
  })

  it('kegg: group lists every real parent, not the single stale stored code', async () => {
    const user = await loadTop('kegg')
    await waitFor(() => expect(screen.getByText(/\+1 more/)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /CSV/ }))
    const rows = downloadCsv.mock.calls[0][0] as Record<string, unknown>[]
    expect(rows.find(r => r.annotation_id === 'K00134')).toMatchObject({
      rank: 'leaf (KO)',
      group: 'Glycolysis / Gluconeogenesis; Messenger RNA biogenesis',
    })
  })
})
