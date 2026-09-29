/**
 * multi-egc-chart.component.test.tsx
 * =====================================
 * Component tests for MultiEgcChart (components/charts/MultiEgcChart.tsx)
 * -- found with zero direct component coverage (only its CSV-row-shape
 * helper, buildMultiEgcCsvRows, was covered elsewhere).
 *
 * Unlike GroupedEgcChart (which sums series together), MultiEgcChart keeps
 * each series separate side-by-side for comparison -- so its own
 * distinctive, easy-to-get-backwards logic is what these tests target:
 * the scaleMismatch heuristic (a real >10x mean-ratio threshold, not a
 * cosmetic check) and StatsPanel receiving one independent value array PER
 * series (W25, docs/AUDIT-2026-09-22.md -- used to pool every series into
 * one flat array, giving one meaningless blended mean/CV for the whole
 * group; now each series gets its own row).
 *
 * Coverage
 * --------
 *   empty state when the date range excludes every point
 *   scaleMismatch warning: fires above the real >10x mean-ratio threshold,
 *     not below it, and is suppressed once metric or standardize moves off
 *     the raw default (both of those already resolve the scale problem)
 *   legend: taxonomy-aware label, italic styling for taxonomy, and
 *     scaffoldsDisabled hides the per-series Scaffold/Hierarchy buttons
 *   stats are per-series (W25), not pooled together -- and same-labelled
 *     groups' data doesn't collide (W26)
 *   dateFrom/dateTo props actually exclude out-of-range points, not just
 *     from the chart but from what feeds the stats too
 *
 * Run: npx vitest run src/tests/multi-egc-chart.component.test.tsx
 */

import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import type { AnnotationItem } from '../types'

function makePoint(datetime: string, egc: number | null): AnnotationItem {
  return {
    source: 'cog', sample: 's1', annotation_id: 'X', name: 'X',
    timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime },
    value: { egc },
  }
}

function statValue(label: string): number {
  const cell = screen.getAllByText(label).find(el => el.className === 'stat-cell-label')!
    .closest('.stat-cell')!
  return Number(cell.querySelector('.stat-cell-value')!.textContent!)
}

// W25 (docs/AUDIT-2026-09-22.md): StatsPanel now renders one labelled block
// per series (`.stats-panel-series`), not one pooled set of numbers -- this
// finds a specific stat within a specific series' own block.
function statValueForSeries(seriesLabel: string, statLabel: string): number {
  const label = screen.getAllByText(seriesLabel, { selector: '.stats-panel-series-label' })[0]
  const block = label.closest('.stats-panel-series')!
  const cell  = within(block).getAllByText(statLabel).find(el => el.className === 'stat-cell-label')!
    .closest('.stat-cell')!
  return Number(cell.querySelector('.stat-cell-value')!.textContent!)
}

// The chart opens on Relative Abundance; tests that assert raw-EGC behaviour
// switch to the EGC pill first.
async function selectRawEgc(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'EGC' }))
}

function pressed(name: string | RegExp): boolean {
  return screen.getByRole('button', { name }).classList.contains('on')
}

describe('MultiEgcChart — defaults', () => {
  const series = [{ id: 'A', annotationId: 'A', name: 'A', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 100)] }]

  it('opens on Relative Abundance with Z-score off', () => {
    render(<MultiEgcChart series={series} dateFrom="" dateTo="" />)
    expect(pressed('Relative Abundance')).toBe(true)
    expect(pressed('EGC')).toBe(false)
    expect(pressed('Z-score')).toBe(false)
  })

  it('opens with Z-score on when defaultStandardize is set, and it stays toggleable', async () => {
    const user = userEvent.setup()
    render(<MultiEgcChart series={series} dateFrom="" dateTo="" defaultStandardize />)
    expect(pressed('Relative Abundance')).toBe(true)
    expect(pressed('Z-score')).toBe(true)
    await user.click(screen.getByTitle('No standardization'))
    expect(pressed('Z-score')).toBe(false)
  })
})

describe('MultiEgcChart — empty state', () => {
  it('shows a message when the date range excludes every point', () => {
    render(
      <MultiEgcChart
        series={[{ id: 'A', annotationId: 'A', name: 'A', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 100)] }]}
        dateFrom="2021-12-01"
        dateTo=""
      />,
    )
    expect(screen.getByText(/No EGC data in range/i)).toBeInTheDocument()
  })
})

describe('MultiEgcChart — scale-mismatch warning', () => {
  it('fires when two series\' mean EGC differ by more than 10x', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[
          { id: 'Small', annotationId: 'Small', name: 'Small', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 10)] },
          { id: 'Big', annotationId: 'Big', name: 'Big', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 200)] },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    await selectRawEgc(user)
    expect(screen.getByText(/very different EGC scales/i)).toBeInTheDocument()
  })

  it('does not fire when series are within 10x of each other', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[
          { id: 'A', annotationId: 'A', name: 'A', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 50)] },
          { id: 'B', annotationId: 'B', name: 'B', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 200)] },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    await selectRawEgc(user)
    expect(screen.queryByText(/very different EGC scales/i)).not.toBeInTheDocument()
  })

  it('is suppressed once Z-score standardization is on, even with a >10x raw gap', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[
          { id: 'Small', annotationId: 'Small', name: 'Small', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 10)] },
          { id: 'Big', annotationId: 'Big', name: 'Big', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 200)] },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    await selectRawEgc(user)
    expect(screen.getByText(/very different EGC scales/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Z-score/i }))
    expect(screen.queryByText(/very different EGC scales/i)).not.toBeInTheDocument()
  })

  it('is suppressed on the Relative Abundance metric, even with a >10x raw gap', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[
          { id: 'Small', annotationId: 'Small', name: 'Small', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 10)] },
          { id: 'Big', annotationId: 'Big', name: 'Big', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 200)] },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    await user.click(screen.getByRole('button', { name: /Relative Abundance/i }))
    expect(screen.queryByText(/very different EGC scales/i)).not.toBeInTheDocument()
  })
})

describe('MultiEgcChart — legend', () => {
  it('shows a taxonomy series\' name in italics, not its raw lineage id', () => {
    render(
      <MultiEgcChart
        series={[{
          id: 'Bacteria;Proteobacteria', annotationId: 'Bacteria;Proteobacteria', name: 'Proteobacteria', color: '#000',
          source: 'taxonomy', data: [makePoint('5/27/21 8:00', 100)],
        }]}
        dateFrom="" dateTo=""
      />,
    )
    const label = screen.getByText('Proteobacteria')
    expect(label.style.fontStyle).toBe('italic')
    expect(screen.queryByText('Bacteria;Proteobacteria')).not.toBeInTheDocument()
  })

  it('shows a non-taxonomy series\' annotation id directly, not italicized', () => {
    render(
      <MultiEgcChart
        series={[{ id: 'COG0001', annotationId: 'COG0001', name: 'GroEL', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 100)] }]}
        dateFrom="" dateTo=""
      />,
    )
    const label = screen.getByText('COG0001')
    expect(label.style.fontStyle).not.toBe('italic')
  })

  it('hides the per-series Scaffold/Hierarchy buttons when scaffoldsDisabled is set', () => {
    render(
      <MultiEgcChart
        series={[{
          id: 'COG0001', annotationId: 'COG0001', name: 'GroEL', color: '#000', source: 'cog',
          data: [makePoint('5/27/21 8:00', 100)], scaffoldsDisabled: true,
        }]}
        dateFrom="" dateTo=""
      />,
    )
    expect(screen.queryByTestId('hierarchy-btn')).not.toBeInTheDocument()
  })

  it('shows the per-series Hierarchy button when scaffoldsDisabled is not set', () => {
    render(
      <MultiEgcChart
        series={[{ id: 'COG0001', annotationId: 'COG0001', name: 'GroEL', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 100)] }]}
        dateFrom="" dateTo=""
      />,
    )
    expect(screen.getByTestId('hierarchy-btn')).toBeInTheDocument()
  })
})

describe('MultiEgcChart — stats are per-series, not pooled (W25)', () => {
  it('each series gets its own n/Mean row -- not blended into one pooled set', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[
          {
            id: 'A', annotationId: 'A', name: 'A', color: '#000', source: 'cog',
            data: [makePoint('5/27/21 8:00', 10), makePoint('5/27/21 12:00', 30)],
          },
          {
            id: 'B', annotationId: 'B', name: 'B', color: '#000', source: 'cog',
            data: [makePoint('5/27/21 8:00', 100), makePoint('5/27/21 12:00', 300)],
          },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    await selectRawEgc(user)
    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    // A's own mean is 20, B's own mean is 200 -- if these were pooled into
    // one blended set (the pre-W25 behavior), there would be only one "n"
    // (4) and one "Mean" (~137.5) describing neither series correctly.
    expect(statValueForSeries('A', 'n')).toBe(2)
    expect(statValueForSeries('A', 'Mean')).toBeCloseTo(20)
    expect(statValueForSeries('B', 'n')).toBe(2)
    expect(statValueForSeries('B', 'Mean')).toBeCloseTo(200)
  })

  // W26 (docs/AUDIT-2026-09-22.md): two different groups sharing the same
  // user-typed label (annotationId) must not collide -- their real,
  // different data must both survive the full render pipeline
  // (baseRows/dtMap, which is keyed internally by `id`, not annotationId).
  // Before `id` existed, the second same-labelled series' points silently
  // overwrote the first's at every shared datetime.
  it('two series sharing the same annotationId (label) both survive -- keyed internally by id, not annotationId', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[
          { id: 'group::iron::1000', annotationId: 'iron (2)', name: 'iron (2)', color: '#000', source: 'kegg', data: [makePoint('5/27/21 8:00', 10)] },
          { id: 'group::iron::2000', annotationId: 'iron (2)', name: 'iron (2)', color: '#000', source: 'cog',  data: [makePoint('5/27/21 8:00', 170000)] },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    await selectRawEgc(user)
    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    // Both series display as "iron (2)" (expected -- that's genuinely what
    // both are labelled), so there are 2 same-labelled blocks; each must
    // carry its own real, distinct value, not one overwriting the other.
    const means = screen.getAllByText('Mean').map(el =>
      Number(el.closest('.stat-cell')!.querySelector('.stat-cell-value')!.textContent),
    )
    expect(means.sort((a, b) => a - b)).toEqual([10, 170000])
  })
})

describe('MultiEgcChart — date range props', () => {
  it('excludes out-of-range points from both the chart and the stats', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[{
          id: 'A', annotationId: 'A', name: 'A', color: '#000', source: 'cog',
          data: [makePoint('5/27/21 8:00', 100), makePoint('6/1/21 8:00', 300)],
        }]}
        dateFrom="2021-05-29" dateTo=""
      />,
    )
    await selectRawEgc(user)
    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    expect(statValue('n')).toBe(1)
    expect(statValue('Mean')).toBeCloseTo(300)
  })
})

// W27 (docs/AUDIT-2026-09-22.md): stats used to be computed from the
// smoothed values -- confirmed live, SD dropped 5.57e-5 -> 4.50e-5 (-19%)
// purely from toggling Smooth on. Verify bar from the audit itself:
// toggling Smooth must never change the reported statistics.
describe('MultiEgcChart — statistics are unaffected by the Smooth toggle (W27)', () => {
  it('n/Mean/Std Dev read identically whether Smooth is on or off', async () => {
    const user = userEvent.setup()
    const points = Array.from({ length: 20 }, (_, i) =>
      makePoint(`5/${27 + i}/21 8:00`, 100 + (i % 2 === 0 ? 40 : -40) + i),
    )
    render(
      <MultiEgcChart
        series={[{ id: 'A', annotationId: 'A', name: 'A', color: '#000', source: 'cog', data: points }]}
        dateFrom="" dateTo=""
      />,
    )
    await selectRawEgc(user)
    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    const before = statValueForSeries('A', 'Std Dev s')

    await user.click(screen.getByTitle('LOWESS: locally weighted regression.'))
    const after = statValueForSeries('A', 'Std Dev s')

    expect(after).toBe(before)
  })
})
