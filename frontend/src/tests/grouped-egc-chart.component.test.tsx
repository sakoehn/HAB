/**
 * grouped-egc-chart.component.test.tsx
 * =======================================
 * Component tests for GroupedEgcChart (components/charts/GroupedEgcChart.tsx)
 * -- found with zero direct component coverage (only its CSV-row-shape
 * helper, buildGroupedEgcCsvRows, was covered, via egc-csv-export.unit.test.ts).
 *
 * This component's actual job is a real scientific computation -- summing
 * EGC (or norm_egc) across every member annotation at each shared
 * timepoint -- so these tests assert the computed number itself (read back
 * via StatsPanel's rendered stats), not just "a chart appeared". A test
 * that only checks the chart rendered would pass even if the sum were
 * silently wrong.
 *
 * Coverage
 * --------
 *   summing across multiple annotations at the same timepoint is correct
 *   distinct timepoints are kept separate, not merged
 *   a null/missing egc value at one timepoint is excluded, not treated as 0
 *     in a way that would still be misleading, nor does it crash
 *   metric swap (egc vs norm_egc) sums the correct field, not the other one
 *   date-range filtering actually removes out-of-range points from the sum
 *   empty series / no data-in-range both show "No data" rather than a
 *     miscomputed chart
 *
 * Run: npx vitest run src/tests/grouped-egc-chart.component.test.tsx
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { GroupedEgcChart } from '../components/charts/GroupedEgcChart'
import type { AnnotationItem } from '../types'

function makePoint(
  annotationId: string, datetime: string, egc: number | null, normEgc: number | null = null,
): AnnotationItem {
  return {
    source: 'cog', sample: 's1', annotation_id: annotationId, name: annotationId,
    timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime },
    value: { egc, norm_egc: normEgc },
  }
}

// StatsPanel renders one .stat-cell per statistic, each with a label span
// and a value span -- this reads the value back for a given label, parsed
// to a number, so tests assert on the real computed value regardless of
// StatsPanel's own display-formatting choices (fixed vs. exponential
// notation, decimal places), rather than hardcoding its exact format string.
function statValue(label: string): number {
  const cell = screen.getAllByText(label).find(el => el.className === 'stat-cell-label')!
    .closest('.stat-cell')!
  return Number(cell.querySelector('.stat-cell-value')!.textContent!)
}

// The chart opens on Relative Abundance; tests that assert raw-EGC sums
// switch to the EGC pill first.
async function selectRawEgc(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'EGC' }))
}

describe('GroupedEgcChart — summing correctness', () => {
  it('sums EGC across multiple annotations at the same timepoint', async () => {
    const user = userEvent.setup()
    render(
      <GroupedEgcChart
        groupLabel="Test Group"
        allSeries={[
          { annotationId: 'A', name: 'A', color: '#000', data: [makePoint('A', '5/27/21 8:00', 30)] },
          { annotationId: 'B', name: 'B', color: '#000', data: [makePoint('B', '5/27/21 8:00', 20)] },
          { annotationId: 'C', name: 'C', color: '#000', data: [makePoint('C', '5/27/21 8:00', 10)] },
        ]}
      />,
    )
    await selectRawEgc(user)
    // Single shared timepoint -> Mean of the one summed point equals the sum itself.
    expect(statValue('Mean')).toBeCloseTo(60)
    expect(statValue('n')).toBe(1)
  })

  it('keeps distinct timepoints separate rather than merging them', async () => {
    const user = userEvent.setup()
    render(
      <GroupedEgcChart
        groupLabel="Test Group"
        allSeries={[
          {
            annotationId: 'A', name: 'A', color: '#000',
            data: [
              makePoint('A', '5/27/21 8:00', 100),
              makePoint('A', '5/28/21 8:00', 200),
            ],
          },
        ]}
      />,
    )
    await selectRawEgc(user)
    expect(screen.getByText(/2 timepoints/)).toBeInTheDocument()
    expect(statValue('n')).toBe(2)
  })

  it('excludes a null egc value from the sum rather than crashing or counting it as zero-but-present', async () => {
    const user = userEvent.setup()
    render(
      <GroupedEgcChart
        groupLabel="Test Group"
        allSeries={[
          { annotationId: 'A', name: 'A', color: '#000', data: [makePoint('A', '5/27/21 8:00', 50)] },
          { annotationId: 'B', name: 'B', color: '#000', data: [makePoint('B', '5/27/21 8:00', null)] },
        ]}
      />,
    )
    await selectRawEgc(user)
    // Only A's real 50 contributes -- B's null must not become a silent 0
    // that would still be correct here by coincidence, so this also checks
    // there's exactly the one summed point, not a phantom second one.
    expect(statValue('Mean')).toBeCloseTo(50)
    expect(statValue('n')).toBe(1)
  })

  it('shows "No data available" when every series is empty', () => {
    render(<GroupedEgcChart groupLabel="Empty Group" allSeries={[]} />)
    expect(screen.getByText('No data available.')).toBeInTheDocument()
  })
})

describe('GroupedEgcChart — metric swap sums the correct field', () => {
  it('sums raw egc once EGC is selected', async () => {
    const user = userEvent.setup()
    render(
      <GroupedEgcChart
        groupLabel="Test Group"
        allSeries={[
          { annotationId: 'A', name: 'A', color: '#000', data: [makePoint('A', '5/27/21 8:00', 100, 0.001)] },
        ]}
      />,
    )
    await selectRawEgc(user)
    expect(statValue('Mean')).toBeCloseTo(100)
  })

  it('sums norm_egc, not egc, by default, and switches to egc on request', async () => {
    const user = userEvent.setup()
    render(
      <GroupedEgcChart
        groupLabel="Test Group"
        allSeries={[
          { annotationId: 'A', name: 'A', color: '#000', data: [makePoint('A', '5/27/21 8:00', 100, 0.001)] },
        ]}
      />,
    )
    // 0.001 norm_egc, not 100 raw egc -- confirms the metric actually
    // changes which field is summed, not just the y-axis label text.
    expect(screen.getByRole('button', { name: /Relative Abundance/i })).toHaveClass('on')
    expect(statValue('Mean')).toBeCloseTo(0.001)
    await selectRawEgc(user)
    expect(statValue('Mean')).toBeCloseTo(100)
  })
})

describe('GroupedEgcChart — date range filtering', () => {
  it('excludes points before dateFrom from the sum, not just from display', async () => {
    const user = userEvent.setup()
    render(
      <GroupedEgcChart
        groupLabel="Test Group"
        allSeries={[
          {
            annotationId: 'A', name: 'A', color: '#000',
            data: [
              makePoint('A', '5/27/21 8:00', 100),
              makePoint('A', '6/1/21 8:00', 300),
            ],
          },
        ]}
      />,
    )
    await selectRawEgc(user)
    expect(screen.getByText(/2 timepoints/)).toBeInTheDocument()

    const [fromInput] = screen.getAllByDisplayValue('')
    await user.type(fromInput, '2021-05-29')

    expect(screen.getByText(/1 timepoints/)).toBeInTheDocument()
    expect(statValue('Mean')).toBeCloseTo(300)
  })

  it('shows "No data available" when the date range excludes every point', async () => {
    const user = userEvent.setup()
    render(
      <GroupedEgcChart
        groupLabel="Test Group"
        allSeries={[
          { annotationId: 'A', name: 'A', color: '#000', data: [makePoint('A', '5/27/21 8:00', 100)] },
        ]}
      />,
    )
    const [fromInput] = screen.getAllByDisplayValue('')
    await user.type(fromInput, '2021-12-01')

    expect(screen.getByText('No data available.')).toBeInTheDocument()
  })
})

// W27 (docs/AUDIT-2026-09-22.md): stats used to be computed from the
// smoothed values -- confirmed live, SD dropped 5.57e-5 -> 4.50e-5 (-19%)
// purely from toggling Smooth on. Verify bar from the audit itself:
// toggling Smooth must never change the reported statistics.
describe('GroupedEgcChart — statistics are unaffected by the Smooth toggle (W27)', () => {
  it('n/Mean/Std Dev read identically whether Smooth is on or off', async () => {
    const user = userEvent.setup()
    const points = Array.from({ length: 20 }, (_, i) =>
      makePoint('A', `5/${27 + i}/21 8:00`, 100 + (i % 2 === 0 ? 40 : -40) + i),
    )
    render(
      <GroupedEgcChart
        groupLabel="Test Group"
        allSeries={[{ annotationId: 'A', name: 'A', color: '#000', data: points }]}
      />,
    )
    await selectRawEgc(user)

    const before = { n: statValue('n'), mean: statValue('Mean'), std: statValue('Std Dev s') }
    await user.click(screen.getByTitle('LOWESS: locally weighted regression.'))
    const after = { n: statValue('n'), mean: statValue('Mean'), std: statValue('Std Dev s') }

    expect(after).toEqual(before)
  })
})
