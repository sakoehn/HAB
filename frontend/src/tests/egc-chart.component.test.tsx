/**
 * egc-chart.component.test.tsx
 * ===============================
 * Component tests for EgcChart (components/charts/EgcChart.tsx) -- found
 * with zero direct component-level coverage by a coverage pass (the
 * existing egc-chart-timepoints.unit.test.ts re-derives the timepoint/date
 * filtering logic independently against utils/format.ts, it never actually
 * imports or renders EgcChart itself). Whatever coverage the file had came
 * entirely incidentally from AnalyzePage/ComparePage rendering it as a
 * child.
 *
 * The three overlay toggles (night shading, tide, day bands) all default
 * off, and useSolarTideData(false) short-circuits without fetching -- so
 * these tests need no fetch mocking for the interactions covered here.
 *
 * Coverage
 * --------
 *   empty state (no EGC values at all)
 *   basic rendering: id/name for cog/kegg vs. the italic taxonomy title
 *   taxonomy lineage toggle (show/hide full annotation_id)
 *   stats panel toggle
 *   timepoint selector: opens, badge text when partial, All/None shortcuts,
 *     toggling an individual date pill, padTime()'s zero-padding on time pills
 *   date range filter narrows "N of M samples"
 *
 * Run: npx vitest run src/tests/egc-chart.component.test.tsx
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { EgcChart } from '../components/charts/EgcChart'
import type { AnnotationItem } from '../types'

function makePoint(datetime: string, egc: number, sample = 's1'): AnnotationItem {
  return {
    source: 'cog', sample, annotation_id: 'COG0001', name: 'GroEL',
    timepoint: { taxon_oid: sample, timepoint: 'T1', datetime },
    value: { egc, norm_egc: egc / 100000 },
  }
}

describe('EgcChart — empty state', () => {
  it('shows a message when there are no EGC values across any sample', () => {
    render(
      <EgcChart data={[]} annotationId="COG0001" annotationName="GroEL" />,
    )
    expect(screen.getByText(/No EGC values found/i)).toBeInTheDocument()
  })

  it('shows the empty message when points exist but none have a usable timepoint', () => {
    const point: AnnotationItem = {
      source: 'cog', sample: 's1', annotation_id: 'COG0001', name: 'GroEL',
      timepoint: null, value: { egc: 100 },
    }
    render(
      <EgcChart data={[point]} annotationId="COG0001" annotationName="GroEL" />,
    )
    expect(screen.getByText(/No EGC values found/i)).toBeInTheDocument()
  })
})

describe('EgcChart — basic rendering', () => {
  it('renders the annotation id and name for a non-taxonomy source', () => {
    render(
      <EgcChart
        data={[makePoint('5/27/21 8:00', 100)]}
        annotationId="COG0001"
        annotationName="GroEL"
        source="cog"
      />,
    )
    expect(screen.getByText('COG0001 — GroEL')).toBeInTheDocument()
  })

  it('renders a taxonomy annotation\'s display name in the title, not the raw lineage id, until expanded', () => {
    render(
      <EgcChart
        data={[makePoint('5/27/21 8:00', 100)]}
        annotationId="Bacteria;Proteobacteria"
        annotationName="Proteobacteria"
        source="taxonomy"
        depth={2}
      />,
    )
    expect(screen.getByText('Proteobacteria')).toBeInTheDocument()
    expect(screen.queryByText('Bacteria;Proteobacteria')).not.toBeInTheDocument()
  })

  it('shows the full lineage id after clicking the taxonomy rank toggle', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart
        data={[makePoint('5/27/21 8:00', 100)]}
        annotationId="Bacteria;Proteobacteria"
        annotationName="Proteobacteria"
        source="taxonomy"
        depth={2}
      />,
    )
    await user.click(screen.getByTitle('Show full lineage'))
    expect(screen.getByText('Bacteria;Proteobacteria')).toBeInTheDocument()
  })

  it('shows the sample count summary', () => {
    render(
      <EgcChart
        data={[makePoint('5/27/21 8:00', 100, 's1'), makePoint('6/1/21 8:00', 200, 's2')]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )
    expect(screen.getByText(/2 of 2 samples/)).toBeInTheDocument()
  })
})

describe('EgcChart — stats panel toggle', () => {
  it('hides the stats panel by default and shows it after clicking Σ Stats', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart
        data={[makePoint('5/27/21 8:00', 100)]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )
    expect(screen.queryByText(/Descriptive Statistics/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    expect(screen.getByText(/Descriptive Statistics/i)).toBeInTheDocument()
  })
})

describe('EgcChart — timepoint selector', () => {
  function threeDayPoints() {
    return [
      makePoint('5/27/21 8:00', 100, 's1'),
      makePoint('5/28/21 8:00', 200, 's2'),
      makePoint('5/29/21 8:00', 300, 's3'),
    ]
  }

  it('opens the timepoint panel and lists one pill per distinct date', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart data={threeDayPoints()} annotationId="COG0001" annotationName="GroEL" />,
    )
    await user.click(screen.getByTitle('Select which timepoints to display'))
    expect(screen.getByText('5/27')).toBeInTheDocument()
    expect(screen.getByText('5/28')).toBeInTheDocument()
    expect(screen.getByText('5/29')).toBeInTheDocument()
  })

  it('deselecting a date pill narrows the sample count and shows the "N of M dates" badge', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart data={threeDayPoints()} annotationId="COG0001" annotationName="GroEL" />,
    )
    await user.click(screen.getByTitle('Select which timepoints to display'))
    await user.click(screen.getByText('5/28'))

    expect(screen.getByText(/2 of 3 dates/)).toBeInTheDocument()
    expect(screen.getByText(/2 of 3 samples/)).toBeInTheDocument()
  })

  it('"None" under Dates clears the selection, showing zero samples', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart data={threeDayPoints()} annotationId="COG0001" annotationName="GroEL" />,
    )
    await user.click(screen.getByTitle('Select which timepoints to display'))
    const dateNoneBtn = screen.getAllByRole('button', { name: 'None' })[0]
    await user.click(dateNoneBtn)

    expect(screen.getByText(/No data in selected range/i)).toBeInTheDocument()
  })

  it('"All" restores every date after narrowing', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart data={threeDayPoints()} annotationId="COG0001" annotationName="GroEL" />,
    )
    await user.click(screen.getByTitle('Select which timepoints to display'))
    await user.click(screen.getByText('5/28'))
    expect(screen.getByText(/2 of 3 samples/)).toBeInTheDocument()

    const dateAllBtn = screen.getAllByRole('button', { name: 'All' })[0]
    await user.click(dateAllBtn)
    expect(screen.getByText(/3 of 3 samples/)).toBeInTheDocument()
  })

  it('zero-pads unpadded raw hour strings for display (padTime), e.g. "8:00" -> "08:00"', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart
        data={[makePoint('5/27/21 8:00', 100, 's1'), makePoint('5/27/21 13:00', 150, 's2')]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )
    await user.click(screen.getByTitle('Select which timepoints to display'))
    // Scoped to the timepoint panel -- Plotly's own axis-tick text can
    // otherwise coincidentally also render a matching time string.
    const panel = screen.getByText('Filter by:').parentElement as HTMLElement
    expect(within(panel).getByText('08:00')).toBeInTheDocument()
    expect(within(panel).getByText('13:00')).toBeInTheDocument()
  })
})

describe('EgcChart — date range filter', () => {
  it('narrows the sample count via the date-from field', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart
        data={[
          makePoint('5/27/21 8:00', 100, 's1'),
          makePoint('6/1/21 8:00', 200, 's2'),
        ]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )
    expect(screen.getByText(/2 of 2 samples/)).toBeInTheDocument()

    const [fromInput] = screen.getAllByDisplayValue('')
    await user.type(fromInput, '2021-05-29')

    expect(screen.getByText(/1 of 2 samples/)).toBeInTheDocument()
  })
})
