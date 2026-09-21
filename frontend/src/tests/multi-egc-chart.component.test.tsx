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
 * cosmetic check) and StatsPanel receiving every raw value from every
 * series pooled together, not summed per timepoint the way
 * GroupedEgcChart's does.
 *
 * Coverage
 * --------
 *   empty state when the date range excludes every point
 *   scaleMismatch warning: fires above the real >10x mean-ratio threshold,
 *     not below it, and is suppressed once metric or standardize moves off
 *     the raw default (both of those already resolve the scale problem)
 *   legend: taxonomy-aware label, italic styling for taxonomy, and
 *     scaffoldsDisabled hides the per-series Scaffold/Hierarchy buttons
 *   stats pool every series' raw values together (not summed per timepoint)
 *   dateFrom/dateTo props actually exclude out-of-range points, not just
 *     from the chart but from what feeds the stats too
 *
 * Run: npx vitest run src/tests/multi-egc-chart.component.test.tsx
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
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

describe('MultiEgcChart — empty state', () => {
  it('shows a message when the date range excludes every point', () => {
    render(
      <MultiEgcChart
        series={[{ annotationId: 'A', name: 'A', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 100)] }]}
        dateFrom="2021-12-01"
        dateTo=""
      />,
    )
    expect(screen.getByText(/No EGC data in range/i)).toBeInTheDocument()
  })
})

describe('MultiEgcChart — scale-mismatch warning', () => {
  it('fires when two series\' mean EGC differ by more than 10x', () => {
    render(
      <MultiEgcChart
        series={[
          { annotationId: 'Small', name: 'Small', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 10)] },
          { annotationId: 'Big', name: 'Big', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 200)] },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    expect(screen.getByText(/very different EGC scales/i)).toBeInTheDocument()
  })

  it('does not fire when series are within 10x of each other', () => {
    render(
      <MultiEgcChart
        series={[
          { annotationId: 'A', name: 'A', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 50)] },
          { annotationId: 'B', name: 'B', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 200)] },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    expect(screen.queryByText(/very different EGC scales/i)).not.toBeInTheDocument()
  })

  it('is suppressed once Z-score standardization is on, even with a >10x raw gap', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[
          { annotationId: 'Small', name: 'Small', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 10)] },
          { annotationId: 'Big', name: 'Big', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 200)] },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    expect(screen.getByText(/very different EGC scales/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Z-score/i }))
    expect(screen.queryByText(/very different EGC scales/i)).not.toBeInTheDocument()
  })

  it('is suppressed on the Relative Abundance metric, even with a >10x raw gap', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[
          { annotationId: 'Small', name: 'Small', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 10)] },
          { annotationId: 'Big', name: 'Big', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 200)] },
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
          annotationId: 'Bacteria;Proteobacteria', name: 'Proteobacteria', color: '#000',
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
        series={[{ annotationId: 'COG0001', name: 'GroEL', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 100)] }]}
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
          annotationId: 'COG0001', name: 'GroEL', color: '#000', source: 'cog',
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
        series={[{ annotationId: 'COG0001', name: 'GroEL', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 100)] }]}
        dateFrom="" dateTo=""
      />,
    )
    expect(screen.getByTestId('hierarchy-btn')).toBeInTheDocument()
  })
})

describe('MultiEgcChart — stats pool every series\' values, unsummed', () => {
  it('Mean reflects every raw value from every series pooled together, not summed per timepoint', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[
          { annotationId: 'A', name: 'A', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 10)] },
          { annotationId: 'B', name: 'B', color: '#000', source: 'cog', data: [makePoint('5/27/21 8:00', 30)] },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    // Pooled mean of [10, 30] is 20 -- if this component accidentally summed
    // per timepoint the way GroupedEgcChart does, n would be 1 and Mean 40.
    expect(statValue('n')).toBe(2)
    expect(statValue('Mean')).toBeCloseTo(20)
  })
})

describe('MultiEgcChart — date range props', () => {
  it('excludes out-of-range points from both the chart and the stats', async () => {
    const user = userEvent.setup()
    render(
      <MultiEgcChart
        series={[{
          annotationId: 'A', name: 'A', color: '#000', source: 'cog',
          data: [makePoint('5/27/21 8:00', 100), makePoint('6/1/21 8:00', 300)],
        }]}
        dateFrom="2021-05-29" dateTo=""
      />,
    )
    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    expect(statValue('n')).toBe(1)
    expect(statValue('Mean')).toBeCloseTo(300)
  })
})
