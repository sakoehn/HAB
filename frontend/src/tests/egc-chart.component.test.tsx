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

// applyZScore is a silent no-op with fewer than 2 real points, so the
// axis/tooltip must not claim "Z-score, σ from mean" then (e.g. nifH,
// K02588, 1 sample, would show its raw 1.13e-7 EGC value as "0.000σ").
describe('EgcChart — Z-score is a no-op with fewer than 2 real points', () => {
  it('does not claim "Z-score" units when the chart has only 1 real EGC value', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart
        data={[makePoint('5/27/21 8:00', 100)]}
        annotationId="K02588"
        annotationName="nifH"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Z-score/i }))

    // The axis/summary line must still read plain "Relative Abundance", not
    // "Relative Abundance (Z-score, σ from mean)" -- applyZScore had
    // nothing to standardize.
    expect(screen.queryByText(/σ from mean/i)).not.toBeInTheDocument()
  })

  it('does claim "Z-score" units once there are 2 or more real points', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart
        data={[makePoint('5/27/21 8:00', 100, 's1'), makePoint('5/27/21 12:00', 110, 's2')]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Z-score/i }))

    expect(screen.getAllByText(/σ from mean/i).length).toBeGreaterThan(0)
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

// Statistics must describe the real values, not the SMOOTHED
// (LOWESS-fitted) curve -- toggling Smooth must never change the reported
// statistics, only the drawn curve (computed from the smoothed values, SD
// would drop 5.57e-5 -> 4.50e-5, -19%, on real data).
describe('EgcChart — statistics are unaffected by the Smooth toggle', () => {
  function statValue(label: string): string {
    return screen.getAllByText(label).find(el => el.className === 'stat-cell-label')!
      .closest('.stat-cell')!.querySelector('.stat-cell-value')!.textContent!
  }

  it('n/Mean/Std Dev read identically whether Smooth is on or off', async () => {
    const user = userEvent.setup()
    // A real, noisy-enough series -- LOWESS actually changes these values
    // when applied (the whole point of this test), unlike a flat/tiny
    // fixture where smoothing would be a no-op regardless of the bug.
    const points = Array.from({ length: 20 }, (_, i) =>
      makePoint(`5/${27 + i}/21 8:00`, 100 + (i % 2 === 0 ? 40 : -40) + i, `s${i}`),
    )
    render(<EgcChart data={points} annotationId="COG0001" annotationName="GroEL" />)

    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    const before = {
      n: statValue('n'), mean: statValue('Mean'), std: statValue('Std Dev s'),
    }

    await user.click(screen.getByTitle('LOWESS: locally weighted regression.'))
    const after = {
      n: statValue('n'), mean: statValue('Mean'), std: statValue('Std Dev s'),
    }

    expect(after).toEqual(before)
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

// A chart's own data only has rows for samples where this specific
// annotation was detected -- there's no row at all for an undetected
// sample, so its own data can't tell "not detected" apart from "sample
// doesn't exist". useAllSamples supplies
// the real, full sample timeline so a chart can merge in an explicit
// gap for anything its own series is missing.
//
// useAllSamples caches at MODULE scope (see its own unit test file for
// why) and every EgcChart in this file mounts it unconditionally, so the
// earlier tests above -- which never mock /api/samples -- already leave
// that cache permanently set to a failed/empty state by the time these
// run. vi.resetModules() + a fresh dynamic re-import of EgcChart gives
// each test its own isolated copy of that cache, the same fix
// use-all-samples.unit.test.ts already uses for the hook directly.
describe('EgcChart — detection gaps (useAllSamples merge)', () => {
  const mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)

  function jsonResponse(data: unknown) {
    return { ok: true, status: 200, statusText: 'OK', json: async () => data }
  }

  async function freshEgcChart() {
    vi.resetModules()
    const mod = await import('../components/charts/EgcChart')
    return mod.EgcChart
  }

  it('discloses an undetected real sample as a gap instead of silently omitting it', async () => {
    const FreshEgcChart = await freshEgcChart()
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/samples?page_size=200') {
        return jsonResponse({
          data: [
            { sample: 's1', timepoint: { taxon_oid: 's1', timepoint: '1', datetime: '5/27/21 8:00' } },
            { sample: 's2', timepoint: { taxon_oid: 's2', timepoint: '2', datetime: '5/28/21 8:00' } },
            { sample: 's3', timepoint: { taxon_oid: 's3', timepoint: '3', datetime: '5/29/21 8:00' } },
          ],
        })
      }
      throw new Error(`unexpected path: ${path}`)
    })

    render(
      <FreshEgcChart
        // s2 never detected this annotation -- data has no row for it at all,
        // same as the real API contract this reproduces.
        data={[makePoint('5/27/21 8:00', 100, 's1'), makePoint('5/29/21 8:00', 150, 's3')]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )

    // Once the real 3-sample timeline loads, the header must show all 3
    // real samples (not just the 2 with data) AND disclose that only 2
    // were actually detected -- silently dropping s2 (the pre-fix
    // behavior) would instead read "2 of 2 samples" with no caveat.
    await screen.findByText(/3 of 3 samples/)
    expect(screen.getByText(/\(detected in 2\)/)).toBeInTheDocument()
  })

  it('does not show the detection caveat when every real sample was actually detected', async () => {
    const FreshEgcChart = await freshEgcChart()
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/samples?page_size=200') {
        return jsonResponse({
          data: [
            { sample: 's1', timepoint: { taxon_oid: 's1', timepoint: '1', datetime: '5/27/21 8:00' } },
            { sample: 's2', timepoint: { taxon_oid: 's2', timepoint: '2', datetime: '5/28/21 8:00' } },
          ],
        })
      }
      throw new Error(`unexpected path: ${path}`)
    })

    render(
      <FreshEgcChart
        data={[makePoint('5/27/21 8:00', 100, 's1'), makePoint('5/28/21 8:00', 150, 's2')]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )

    await screen.findByText(/2 of 2 samples/)
    expect(screen.queryByText(/detected in/)).not.toBeInTheDocument()
  })

  // On a failed /api/samples fetch, allPoints has nothing to merge in but
  // this annotation's own detected rows -- every one of them is
  // "detected", so the header reads e.g. "2 of 2 samples" with no
  // "(detected in N)" qualifier, visually identical to the
  // genuinely-detected-everywhere case above. A warning must say so.
  it('surfaces a visible warning when /api/samples fails, instead of silently looking fully-detected', async () => {
    const FreshEgcChart = await freshEgcChart()
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/samples?page_size=200') {
        throw new Error('network error')
      }
      throw new Error(`unexpected path: ${path}`)
    })

    render(
      <FreshEgcChart
        data={[makePoint('5/27/21 8:00', 100, 's1'), makePoint('5/28/21 8:00', 150, 's2')]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )

    await screen.findByText(/full sample timeline unavailable/i)
  })
})

// The Z-score is taken over the whole series, not over the samples left
// after the date range or Timepoints pills: the same sample keeps the same
// Z however the chart is zoomed, as the Methods page states.
describe('EgcChart — Z-score does not depend on the date range shown', () => {
  function statValue(label: string): number {
    return Number(screen.getAllByText(label).find(el => el.className === 'stat-cell-label')!
      .closest('.stat-cell')!.querySelector('.stat-cell-value')!.textContent!)
  }

  it('a narrowed range keeps each sample at its whole-series Z', async () => {
    const user = userEvent.setup()
    // Whole series 10, 10, 20, 20: mean 15, SD 5, so the two later
    // samples are +1 each. Standardised over just those two, both would
    // read 0 instead.
    render(
      <EgcChart
        data={[
          makePoint('5/27/21 8:00', 10, 's1'),
          makePoint('5/28/21 8:00', 10, 's2'),
          makePoint('6/1/21 8:00', 20, 's3'),
          makePoint('6/2/21 8:00', 20, 's4'),
        ]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Z-score/i }))
    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    expect(statValue('Mean')).toBeCloseTo(0)

    const [fromInput] = screen.getAllByDisplayValue('')
    await user.type(fromInput, '2021-05-30')

    expect(screen.getByText(/2 of 4 samples/)).toBeInTheDocument()
    expect(statValue('Mean')).toBeCloseTo(1)
  })

  it('unticking dates with the Timepoints pills does not change the Z either', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart
        data={[
          makePoint('5/27/21 8:00', 10, 's1'),
          makePoint('5/28/21 8:00', 10, 's2'),
          makePoint('6/1/21 8:00', 20, 's3'),
          makePoint('6/2/21 8:00', 20, 's4'),
        ]}
        annotationId="COG0001"
        annotationName="GroEL"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Z-score/i }))
    await user.click(screen.getByRole('button', { name: /Σ Stats/i }))
    await user.click(screen.getByRole('button', { name: /Timepoints/i }))
    await user.click(screen.getByRole('button', { name: '5/27' }))
    await user.click(screen.getByRole('button', { name: '5/28' }))

    expect(statValue('Mean')).toBeCloseTo(1)
  })
})
