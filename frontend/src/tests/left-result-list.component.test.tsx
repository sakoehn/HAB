/**
 * left-result-list.component.test.tsx
 * ======================================
 * Component tests for LeftResultList (components/annotations/LeftResultList.tsx)
 * -- the Analyze page's left-column result list. Purely presentational
 * (checked state and action callbacks are all owned by AnalyzePage), except
 * for its own local source/rank filter state and per-term filter memory,
 * which is exactly what this file targets: before these tests, only static
 * rendering was exercised (incidentally, via analyze-page.component.test.tsx),
 * not the filter pills, select-all, term-switch inheritance, or row clicks.
 *
 * Coverage
 * --------
 *   empty state / basic rendering / result count strip
 *   source filter pills: shown only with >1 source, toggle on/off, "All" clears
 *   taxonomy rank filter pills: shown only when taxonomy included + >1 rank,
 *     toggle narrows only taxonomy rows, "All" clears
 *   per-term filter memory: a never-visited term inherits the previous term's
 *     filter; an already-visited term keeps its own
 *   select-all: checks/unchecks every visible row, respects the active filter
 *   row interactions: body click adds (unless already in right panel),
 *     checkbox click toggles
 *
 * Run: npx vitest run src/tests/left-result-list.component.test.tsx
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { LeftResultList } from '../components/annotations/LeftResultList'
import type { AnnotationItem, SeriesCache } from '../types'

function makeRow(overrides: Partial<AnnotationItem> = {}): AnnotationItem {
  return {
    source:        'cog',
    sample:        '',
    timepoint:     null,
    annotation_id: 'COG0001',
    name:          'Chaperonin GroEL',
    value:         {},
    mean_egc:      100,
    ...overrides,
  }
}

function renderList(overrides: Partial<Parameters<typeof LeftResultList>[0]> = {}) {
  const props = {
    rows:            [] as AnnotationItem[],
    termLabel:       'iron',
    checkedKeys:     new Set<string>(),
    seriesCache:     {} as SeriesCache,
    rightCardKeys:   new Set<string>(),
    copiedId:        null,
    onCopy:          vi.fn(),
    onToggleCheck:   vi.fn(),
    onAddSingle:     vi.fn(),
    onAddSelected:   vi.fn(),
    onGroupSelected: vi.fn(),
    total:           overrides.rows?.length ?? 0,
    ...overrides,
  }
  const view = render(<LeftResultList {...props} />)
  return { ...view, props }
}

describe('LeftResultList — empty state and basics', () => {
  it('shows a message when there are no rows', () => {
    renderList({ rows: [], total: 0 })
    expect(screen.getByText('No results for this term.')).toBeInTheDocument()
  })

  it('renders each row\'s annotation id and source tag', () => {
    renderList({
      rows: [makeRow({ annotation_id: 'COG0001', source: 'cog' })],
      total: 1,
    })
    expect(screen.getByText('COG0001')).toBeInTheDocument()
    expect(screen.getByText('cog')).toBeInTheDocument()
  })

  it('shows the total result count when no filter is active', () => {
    renderList({ rows: [makeRow()], total: 1 })
    expect(screen.getByText(/1 result/)).toBeInTheDocument()
  })
})

// Two genuine cross-lineage taxonomy homonyms (same bare name, different
// ancestry, e.g. Bosea under two families) would otherwise render with
// identical name + identical rank label, with nothing inviting the user to
// notice they're different taxa.
describe('LeftResultList — taxonomy homonym disambiguation', () => {
  it('shows the immediate parent next to the name and the full lineage as a title tooltip', () => {
    renderList({
      rows: [
        makeRow({
          source: 'taxonomy', depth: 6, name: 'Bosea',
          annotation_id: 'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Boseaceae;Bosea',
        }),
      ],
      total: 1,
    })
    expect(screen.getByText(/in Boseaceae/)).toBeInTheDocument()
    expect(document.querySelector('.al-row-name')).toHaveAttribute(
      'title',
      'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Boseaceae;Bosea',
    )
  })

  it('distinguishes two real cross-lineage Bosea homonyms by their immediate parent', () => {
    renderList({
      rows: [
        makeRow({
          source: 'taxonomy', depth: 6, name: 'Bosea',
          annotation_id: 'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Boseaceae;Bosea',
        }),
        makeRow({
          source: 'taxonomy', depth: 6, name: 'Bosea',
          annotation_id: 'Bacteria;Proteobacteria;Alphaproteobacteria;Hyphomicrobiales;SomeOtherFamily;Bosea',
        }),
      ],
      total: 2,
    })
    expect(screen.getByText(/in Boseaceae/)).toBeInTheDocument()
    expect(screen.getByText(/in SomeOtherFamily/)).toBeInTheDocument()
  })

  // JGI repeats a name down the ranks (a species and its strain share it), so
  // one lineage sits inside the other. The row's rank badge already tells
  // them apart; the "in ..." slot must still name a parent, never a rank.
  it('shows the real parent, not a rank word, for a species and its same-named strain', () => {
    const species = 'Bacteria;Bacteroidetes;Flavobacteriia;Flavobacteriales;Flavobacteriaceae;Polaribacter;Polaribacter sp. Hel1_33_96'
    renderList({
      rows: [
        makeRow({ source: 'taxonomy', depth: 7, name: 'Polaribacter sp. Hel1_33_96', annotation_id: species }),
        makeRow({ source: 'taxonomy', depth: 8, name: 'Polaribacter sp. Hel1_33_96', annotation_id: `${species};Polaribacter sp. Hel1_33_96` }),
      ],
      total: 2,
    })
    const hints = [...document.querySelectorAll('.al-row-parent-hint')].map(el => el.textContent?.trim())
    expect(hints).toEqual(['in Polaribacter', 'in Polaribacter sp. Hel1_33_96'])
  })

  it('names the ancestor that differs when two same-named taxa share their parent', () => {
    renderList({
      rows: [
        makeRow({ source: 'taxonomy', depth: 4, name: 'X', annotation_id: 'Bacteria;PhylumA;unclassified;X' }),
        makeRow({ source: 'taxonomy', depth: 4, name: 'X', annotation_id: 'Bacteria;PhylumB;unclassified;X' }),
      ],
      total: 2,
    })
    expect(screen.getByText(/in PhylumA/)).toBeInTheDocument()
    expect(screen.getByText(/in PhylumB/)).toBeInTheDocument()
  })

  it('does not show a parent hint for a domain-level taxon (no parent above it)', () => {
    renderList({
      rows: [makeRow({ source: 'taxonomy', depth: 1, name: 'Bacteria', annotation_id: 'Bacteria' })],
      total: 1,
    })
    expect(screen.queryByText(/ in /)).not.toBeInTheDocument()
  })

  it('does not show a parent hint or lineage title for non-taxonomy sources', () => {
    renderList({
      rows: [makeRow({ source: 'cog', annotation_id: 'COG0001', name: 'Chaperonin GroEL' })],
      total: 1,
    })
    expect(screen.queryByText(/ in /)).not.toBeInTheDocument()
    expect(screen.getByText('Chaperonin GroEL').closest('.al-row-name')).not.toHaveAttribute('title')
  })
})

describe('LeftResultList — source filter pills', () => {
  it('does not show filter pills when only one source is present', () => {
    renderList({ rows: [makeRow({ source: 'cog' })], total: 1 })
    expect(screen.queryByText('All')).not.toBeInTheDocument()
  })

  it('shows a pill per source when multiple sources are present', () => {
    renderList({
      rows: [makeRow({ source: 'cog' }), makeRow({ source: 'kegg', annotation_id: 'K00001' })],
      total: 2,
    })
    expect(screen.getByRole('button', { name: 'cog' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'kegg' })).toBeInTheDocument()
  })

  it('clicking a source pill narrows the visible rows to that source', async () => {
    const user = userEvent.setup()
    renderList({
      rows: [
        makeRow({ source: 'cog', annotation_id: 'COG0001' }),
        makeRow({ source: 'kegg', annotation_id: 'K00001' }),
      ],
      total: 2,
    })

    await user.click(screen.getByRole('button', { name: 'cog' }))

    expect(screen.getByText('COG0001')).toBeInTheDocument()
    expect(screen.queryByText('K00001')).not.toBeInTheDocument()
    // Narrowed-count strip reads "N of Total" once a filter is active.
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('clicking an already-active source pill deselects it (shows all again)', async () => {
    const user = userEvent.setup()
    renderList({
      rows: [
        makeRow({ source: 'cog', annotation_id: 'COG0001' }),
        makeRow({ source: 'kegg', annotation_id: 'K00001' }),
      ],
      total: 2,
    })

    await user.click(screen.getByRole('button', { name: 'cog' }))
    expect(screen.queryByText('K00001')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'cog' }))
    expect(screen.getByText('K00001')).toBeInTheDocument()
  })

  it('clicking "All" clears an active source filter', async () => {
    const user = userEvent.setup()
    renderList({
      rows: [
        makeRow({ source: 'cog', annotation_id: 'COG0001' }),
        makeRow({ source: 'kegg', annotation_id: 'K00001' }),
      ],
      total: 2,
    })

    await user.click(screen.getByRole('button', { name: 'cog' }))
    expect(screen.queryByText('K00001')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('K00001')).toBeInTheDocument()
  })
})

describe('LeftResultList — taxonomy rank filter pills', () => {
  it('is hidden when there is only one taxonomy rank present', () => {
    renderList({
      rows: [
        makeRow({ source: 'taxonomy', annotation_id: 'Bacteria', depth: 1 }),
        makeRow({ source: 'cog', annotation_id: 'COG0001' }),
      ],
      total: 2,
    })
    expect(screen.queryByText('Rank')).not.toBeInTheDocument()
  })

  it('is shown when 2+ taxonomy ranks are present', () => {
    renderList({
      rows: [
        makeRow({ source: 'taxonomy', annotation_id: 'Bacteria', depth: 1 }),
        makeRow({ source: 'taxonomy', annotation_id: 'Bacteria;Proteobacteria', depth: 2 }),
      ],
      total: 2,
    })
    expect(screen.getByText('Rank')).toBeInTheDocument()
  })

  it('is hidden once a non-taxonomy source filter is active', async () => {
    const user = userEvent.setup()
    renderList({
      rows: [
        makeRow({ source: 'taxonomy', annotation_id: 'Bacteria', depth: 1 }),
        makeRow({ source: 'taxonomy', annotation_id: 'Bacteria;Proteobacteria', depth: 2 }),
        makeRow({ source: 'cog', annotation_id: 'COG0001' }),
      ],
      total: 3,
    })
    expect(screen.getByText('Rank')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'cog' }))
    expect(screen.queryByText('Rank')).not.toBeInTheDocument()
  })

  it('narrows only the taxonomy rows to the selected rank, leaving other sources untouched', async () => {
    const user = userEvent.setup()
    renderList({
      rows: [
        makeRow({ source: 'taxonomy', annotation_id: 'Bacteria', depth: 1, name: 'Bacteria' }),
        makeRow({ source: 'taxonomy', annotation_id: 'Bacteria;Proteobacteria', depth: 2, name: 'Proteobacteria' }),
        makeRow({ source: 'cog', annotation_id: 'COG0001' }),
      ],
      total: 3,
    })

    await user.click(screen.getByRole('button', { name: 'Domain' }))

    expect(screen.getByText('Bacteria')).toBeInTheDocument()
    expect(screen.queryByText('Proteobacteria')).not.toBeInTheDocument()
    // cog row (no rank concept) passes through untouched.
    expect(screen.getByText('COG0001')).toBeInTheDocument()
  })

  it('clicking "All" under the rank pills clears the rank filter', async () => {
    const user = userEvent.setup()
    renderList({
      rows: [
        makeRow({ source: 'taxonomy', annotation_id: 'Bacteria', depth: 1, name: 'Bacteria' }),
        makeRow({ source: 'taxonomy', annotation_id: 'Bacteria;Proteobacteria', depth: 2, name: 'Proteobacteria' }),
      ],
      total: 2,
    })

    await user.click(screen.getByRole('button', { name: 'Domain' }))
    expect(screen.queryByText('Proteobacteria')).not.toBeInTheDocument()

    const rankFilterBar = screen.getByText('Rank').closest('div') as HTMLElement
    await user.click(within(rankFilterBar).getByRole('button', { name: 'All' }))
    expect(screen.getByText('Proteobacteria')).toBeInTheDocument()
  })
})

describe('LeftResultList — per-term filter memory', () => {
  it('a never-visited term inherits the previous term\'s source filter', async () => {
    const user = userEvent.setup()
    const rows = [
      makeRow({ source: 'cog', annotation_id: 'COG0001' }),
      makeRow({ source: 'kegg', annotation_id: 'K00001' }),
    ]
    const { rerender, props } = renderList({ rows, total: 2, termLabel: 'iron' })

    await user.click(screen.getByRole('button', { name: 'cog' }))
    expect(screen.queryByText('K00001')).not.toBeInTheDocument()

    // Switch to a term never seen before -- must inherit the 'iron' tab's filter.
    rerender(<LeftResultList {...props} termLabel="transport" />)
    expect(screen.queryByText('K00001')).not.toBeInTheDocument()
    expect(screen.getByText('COG0001')).toBeInTheDocument()
  })

  it('switching back to an already-visited term keeps its own filter, unaffected by changes made on another tab since', async () => {
    const user = userEvent.setup()
    const rows = [
      makeRow({ source: 'cog', annotation_id: 'COG0001' }),
      makeRow({ source: 'kegg', annotation_id: 'K00001' }),
    ]
    const { rerender, props } = renderList({ rows, total: 2, termLabel: 'iron' })

    // 'iron' tab: filter down to cog.
    await user.click(screen.getByRole('button', { name: 'cog' }))
    expect(screen.queryByText('K00001')).not.toBeInTheDocument()

    // 'transport' tab: never visited, inherits 'iron's cog-only filter --
    // then explicitly cleared back to "All" on this tab specifically.
    rerender(<LeftResultList {...props} termLabel="transport" />)
    expect(screen.queryByText('K00001')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('K00001')).toBeInTheDocument()

    // Back to 'iron' -- its own cog-only filter must still be in effect,
    // not overwritten by 'transport' having since been cleared to "All".
    rerender(<LeftResultList {...props} termLabel="iron" />)
    expect(screen.queryByText('K00001')).not.toBeInTheDocument()
    expect(screen.getByText('COG0001')).toBeInTheDocument()
  })
})

describe('LeftResultList — select all', () => {
  it('checks every visible row when none are checked', async () => {
    const user = userEvent.setup()
    const onToggleCheck = vi.fn()
    renderList({
      rows: [
        makeRow({ source: 'cog', annotation_id: 'COG0001' }),
        makeRow({ source: 'cog', annotation_id: 'COG0002' }),
      ],
      total: 2,
      onToggleCheck,
    })

    await user.click(screen.getByRole('checkbox'))

    expect(onToggleCheck).toHaveBeenCalledWith('COG0001::cog')
    expect(onToggleCheck).toHaveBeenCalledWith('COG0002::cog')
    expect(onToggleCheck).toHaveBeenCalledTimes(2)
  })

  it('unchecks every visible row when all are already checked', async () => {
    const user = userEvent.setup()
    const onToggleCheck = vi.fn()
    renderList({
      rows: [
        makeRow({ source: 'cog', annotation_id: 'COG0001' }),
        makeRow({ source: 'cog', annotation_id: 'COG0002' }),
      ],
      total: 2,
      checkedKeys: new Set(['COG0001::cog', 'COG0002::cog']),
      onToggleCheck,
    })

    await user.click(screen.getByRole('checkbox'))

    expect(onToggleCheck).toHaveBeenCalledWith('COG0001::cog')
    expect(onToggleCheck).toHaveBeenCalledWith('COG0002::cog')
    expect(onToggleCheck).toHaveBeenCalledTimes(2)
  })

  it('shows the selected count once some rows are checked', () => {
    renderList({
      rows: [makeRow({ annotation_id: 'COG0001' })],
      total: 1,
      checkedKeys: new Set(['COG0001::cog']),
    })
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('only toggles the currently visible (filtered) rows, not hidden ones', async () => {
    const user = userEvent.setup()
    const onToggleCheck = vi.fn()
    renderList({
      rows: [
        makeRow({ source: 'cog', annotation_id: 'COG0001' }),
        makeRow({ source: 'kegg', annotation_id: 'K00001' }),
      ],
      total: 2,
      onToggleCheck,
    })

    await user.click(screen.getByRole('button', { name: 'cog' }))
    await user.click(screen.getByRole('checkbox'))

    expect(onToggleCheck).toHaveBeenCalledWith('COG0001::cog')
    expect(onToggleCheck).not.toHaveBeenCalledWith('K00001::kegg')
  })
})

describe('LeftResultList — row interactions', () => {
  it('clicking a row body adds it via onAddSingle', async () => {
    const user = userEvent.setup()
    const onAddSingle = vi.fn()
    const row = makeRow({ annotation_id: 'COG0001' })
    renderList({ rows: [row], total: 1, onAddSingle })

    await user.click(screen.getByText('COG0001'))
    expect(onAddSingle).toHaveBeenCalledWith(row)
  })

  it('does not call onAddSingle when the row is already in the right panel', async () => {
    const user = userEvent.setup()
    const onAddSingle = vi.fn()
    renderList({
      rows: [makeRow({ annotation_id: 'COG0001' })],
      total: 1,
      rightCardKeys: new Set(['COG0001::cog']),
      onAddSingle,
    })

    await user.click(screen.getByText('COG0001'))
    expect(onAddSingle).not.toHaveBeenCalled()
  })

  it('clicking the dedicated + button adds via onAddSingle (distinct from the row-body click)', async () => {
    const user = userEvent.setup()
    const onAddSingle = vi.fn()
    const row = makeRow({ annotation_id: 'COG0001' })
    renderList({ rows: [row], total: 1, onAddSingle })

    await user.click(screen.getByTitle('Add chart to right panel'))
    expect(onAddSingle).toHaveBeenCalledWith(row)
  })

  it('clicking the row checkbox calls onToggleCheck with that row\'s key', async () => {
    const user = userEvent.setup()
    const onToggleCheck = vi.fn()
    renderList({
      rows: [makeRow({ annotation_id: 'COG0001' })],
      total: 1,
      onToggleCheck,
    })

    await user.click(screen.getByTitle('Select for bulk add or group'))
    expect(onToggleCheck).toHaveBeenCalledWith('COG0001::cog')
  })
})

// mean_egc is a mean over samples where the annotation was actually
// detected, not all 128 -- without saying how many samples it came from, a
// 9-sample mean and a 128-sample mean would look identical.
describe('LeftResultList — detection count disclosure', () => {
  it('shows (N/128) next to the mean when sample_count is under the full 128', () => {
    renderList({
      rows: [makeRow({ annotation_id: 'COG0001', mean_egc: 100, sample_count: 9 })],
      total: 1,
    })
    expect(screen.getByText('(9/128)')).toBeInTheDocument()
  })

  it('does not show a detection count when the annotation was detected in all 128 samples', () => {
    renderList({
      rows: [makeRow({ annotation_id: 'COG0001', mean_egc: 100, sample_count: 128 })],
      total: 1,
    })
    expect(screen.queryByText(/\/128\)/)).not.toBeInTheDocument()
  })

  it('does not show a detection count when sample_count is absent (older/other response shapes)', () => {
    renderList({
      rows: [makeRow({ annotation_id: 'COG0001', mean_egc: 100 })],
      total: 1,
    })
    expect(screen.queryByText(/\/128\)/)).not.toBeInTheDocument()
  })
})
