/**
 * tide-trace-native-resolution.component.test.tsx
 * ===================================================
 * Component-level wiring test for the native-resolution tide trace.
 *
 * utils.pure.test.ts already covers nativeTideTrace() thoroughly in
 * isolation, but nothing exercised whether EgcChart, GroupedEgcChart, and
 * MultiEgcChart actually WIRE its output into the rendered Plotly trace.
 * Real Plotly doesn't render meaningful SVG under jsdom (confirmed:
 * egc-chart.component.test.tsx's own docblock avoids the tide-ON path
 * entirely for this reason), so this mocks react-plotly.js/factory to
 * capture the `data` prop passed to <Plot>, which is where the wiring
 * actually lives -- a real, direct check, not a workaround.
 *
 * Coverage
 * --------
 *   EgcChart: the rendered tide trace has as many points as the raw tide
 *     series (native resolution), not the (far smaller) EGC sample count
 *   EgcChart: a date-range filter bounds the tide trace to that range
 *   GroupedEgcChart, MultiEgcChart: same native-resolution check
 *
 * Run: npx vitest run src/tests/tide-trace-native-resolution.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { AnnotationItem } from '../types'

// ── Capture what each chart actually passes to <Plot data={...}> ──────────
let capturedData: Array<{ name?: string; x?: unknown[]; y?: unknown[] }> = []

vi.mock('react-plotly.js/factory', () => ({
  default: () => (props: { data: typeof capturedData }) => {
    capturedData = props.data
    return null
  },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

// 25 real 6-min-resolution tide readings spanning ~2.5h -- deliberately far
// more than the 2 sparse EGC sample points below, so "native resolution"
// and "snapped to sample count" are trivially distinguishable. The samples
// below bracket all 25 (08:00 and 10:30), since the tide line stops at the
// first and last sample.
function makeDenseTides() {
  return Array.from({ length: 25 }, (_, i) => {
    const totalMin = i * 6
    const hh = String(8 + Math.floor(totalMin / 60)).padStart(2, '0')
    const mm = String(totalMin % 60).padStart(2, '0')
    return { time: `2021-05-27 ${hh}:${mm}`, predicted_wl: 1 + Math.sin(i / 4) }
  })
}

function makeSparsePoint(datetime: string, egc: number, sample = 's1'): AnnotationItem {
  return {
    source: 'cog', sample, annotation_id: 'COG0001', name: 'GroEL',
    timepoint: { taxon_oid: sample, timepoint: 'T1', datetime },
    value: { egc, norm_egc: egc / 100000 },
  }
}

beforeEach(() => {
  capturedData = []
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/tides'))
      return Promise.resolve(jsonResponse({
        station: 'test', shift_applied_hr: 0, unit: 'm',
        total: 25, data: makeDenseTides(),
      }))
    if (url.includes('/api/sun-times'))
      return Promise.resolve(jsonResponse({
        location: 'test', lat: 0, lon: 0, tz_offset: 0,
        date_min: null, date_max: null, data: {},
      }))
    return Promise.resolve(jsonResponse({}))
  })
})

function tideTraceFrom(data: typeof capturedData) {
  return data.find(t => t.name === 'Tide (m)')
}

describe('EgcChart — tide trace wiring', () => {
  it('the rendered tide trace has as many points as the real tide data, not the EGC sample count', async () => {
    const user = userEvent.setup()
    const { EgcChart } = await import('../components/charts/EgcChart')
    render(
      <EgcChart
        data={[makeSparsePoint('5/27/21 8:00', 100, 's1'), makeSparsePoint('5/27/21 10:30', 110, 's2')]}
        annotationId="COG0001"
        annotationName="GroEL"
        source="cog"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Tide/i }))

    await waitFor(() => {
      const tideTrace = tideTraceFrom(capturedData)
      expect(tideTrace).toBeTruthy()
      expect(tideTrace!.x!.length).toBe(25)
    })
    // The EGC data only has 2 points -- if this were still snapped to
    // sample cadence (the pre-fix behavior), the tide trace could have at
    // most 2 points too.
    expect(tideTraceFrom(capturedData)!.x!.length).toBeGreaterThan(2)
  })

  it('a date-range filter bounds the tide trace to that range without losing native resolution', async () => {
    const user = userEvent.setup()
    const { EgcChart } = await import('../components/charts/EgcChart')
    // A 2nd EGC sample on 5/28 (all tide readings stay on 5/27, per
    // makeDenseTides) keeps at least one point after filtering -- EgcChart
    // unmounts <Plot> entirely when the date-filtered EGC series is empty
    // (`processedPoints.length === 0 ? <em>No data...</em> : <Plot .../>`),
    // which would make this test wrongly read capturedData from before the
    // filter was applied rather than actually exercising the filtered case.
    // Distinct sample ids ('s1'/'s2') -- makeSparsePoint's own `sample`
    // default is shared across calls, and allPoints keys its per-point map
    // by sample, so two points reusing
    // the same default id would collide and silently drop one of them.
    render(
      <EgcChart
        data={[makeSparsePoint('5/27/21 8:00', 100, 's1'), makeSparsePoint('5/28/21 10:00', 110, 's2')]}
        annotationId="COG0001"
        annotationName="GroEL"
        source="cog"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Tide/i }))
    await waitFor(() => expect(tideTraceFrom(capturedData)).toBeTruthy())
    expect(tideTraceFrom(capturedData)!.x!.length).toBe(25)

    const dateInputs = document.querySelectorAll('.date-field')
    fireEvent.change(dateInputs[0], { target: { value: '2021-05-28' } })

    await waitFor(() => {
      // Every real tide reading is on 2021-05-27 -- a from-date of the
      // 28th must exclude all of them, even though the 5/28 EGC sample
      // keeps the chart (and <Plot>) itself rendered.
      expect(tideTraceFrom(capturedData)!.x!.length).toBe(0)
    })
  })
})

describe('GroupedEgcChart — tide trace wiring (Tides)', () => {
  it('the rendered tide trace has as many points as the real tide data, not the summed-series sample count', async () => {
    const user = userEvent.setup()
    const { GroupedEgcChart } = await import('../components/charts/GroupedEgcChart')
    render(
      <GroupedEgcChart
        allSeries={[
          {
            annotationId: 'COG0001', name: 'COG0001', color: '#000',
            data: [makeSparsePoint('5/27/21 8:00', 100, 's1'), makeSparsePoint('5/27/21 10:30', 110, 's2')],
          },
        ]}
        groupLabel="Test group"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Tide/i }))

    await waitFor(() => {
      const tideTrace = tideTraceFrom(capturedData)
      expect(tideTrace).toBeTruthy()
      expect(tideTrace!.x!.length).toBe(25)
    })
  })
})

describe('MultiEgcChart — tide trace wiring (Tides)', () => {
  it('the rendered tide trace has as many points as the real tide data, not the per-series sample count', async () => {
    const user = userEvent.setup()
    const { MultiEgcChart } = await import('../components/charts/MultiEgcChart')
    render(
      <MultiEgcChart
        series={[
          {
            id: 'A', annotationId: 'COG0001', name: 'COG0001', color: '#000', source: 'cog',
            data: [makeSparsePoint('5/27/21 8:00', 100, 's1'), makeSparsePoint('5/27/21 10:30', 110, 's2')],
          },
        ]}
        dateFrom="" dateTo=""
      />,
    )
    await user.click(screen.getByRole('button', { name: /^EGC$/i }))
    await user.click(screen.getByRole('button', { name: /Tide/i }))

    await waitFor(() => {
      const tideTrace = tideTraceFrom(capturedData)
      expect(tideTrace).toBeTruthy()
      expect(tideTrace!.x!.length).toBe(25)
    })
  })
})
