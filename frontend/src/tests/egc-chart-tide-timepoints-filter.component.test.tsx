/**
 * egc-chart-tide-timepoints-filter.component.test.tsx
 * =======================================================
 * EgcChart's native tide overlay must be bounded by the Timepoints pill
 * filter (selectedDates/selectedTimes) too, not just dateFrom/dateTo --
 * otherwise narrowing via pills would still show a tide trace spanning the
 * whole loaded range, out of sync with the EGC line itself.
 *
 * In its own file, not alongside tide-trace-native-resolution.component.
 * test.tsx's other tide tests: useSolarTideData caches its /api/tides
 * result at MODULE scope, so a per-file-fresh module registry (the normal
 * vitest default) is simpler and more reliable here than fighting that
 * cache with vi.resetModules() inside a shared file.
 *
 * Run: npx vitest run src/tests/egc-chart-tide-timepoints-filter.component.test.tsx
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { EgcChart } from '../components/charts/EgcChart'
import type { AnnotationItem } from '../types'

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

// 25 readings on 5/27, 25 more on 5/28 -- real tide data across both EGC
// sample dates, so narrowing to just one date is a real, visible change.
function makeTwoDayTides() {
  const oneDay = (date: string) => Array.from({ length: 25 }, (_, i) => {
    const totalMin = i * 6
    const hh = String(8 + Math.floor(totalMin / 60)).padStart(2, '0')
    const mm = String(totalMin % 60).padStart(2, '0')
    return { time: `${date} ${hh}:${mm}`, predicted_wl: 1 + Math.sin(i / 4), tide_event: null }
  })
  return [...oneDay('2021-05-27'), ...oneDay('2021-05-28')]
}

function makeSparsePoint(datetime: string, egc: number, sample: string): AnnotationItem {
  return {
    source: 'cog', sample, annotation_id: 'COG0001', name: 'GroEL',
    timepoint: { taxon_oid: sample, timepoint: 'T1', datetime },
    value: { egc, norm_egc: egc / 100000 },
  }
}

function tideTraceFrom(data: typeof capturedData) {
  return data.find(t => t.name === 'Tide (m)')
}

mockFetch.mockImplementation((url: string) => {
  if (url.includes('/api/tides'))
    return Promise.resolve(jsonResponse({
      station: 'test', shift_applied_hr: 0, unit: 'm', total: 50, data: makeTwoDayTides(),
    }))
  if (url.includes('/api/sun-times'))
    return Promise.resolve(jsonResponse({
      location: 'test', lat: 0, lon: 0, tz_offset: 0, date_min: null, date_max: null, data: {},
    }))
  return Promise.resolve(jsonResponse({}))
})

describe('EgcChart — Timepoints pill filter also bounds the tide trace', () => {
  it('narrows the tide trace to the selected dates, with dateFrom/dateTo left untouched', async () => {
    const user = userEvent.setup()
    render(
      <EgcChart
        data={[makeSparsePoint('5/27/21 8:00', 100, 's1'), makeSparsePoint('5/28/21 8:00', 110, 's2')]}
        annotationId="COG0001"
        annotationName="GroEL"
        source="cog"
      />,
    )
    await user.click(screen.getByRole('button', { name: /Tide/i }))
    await waitFor(() => expect(tideTraceFrom(capturedData)!.x!.length).toBe(50))

    // Open the Timepoints panel and deselect 5/28 -- dateFrom/dateTo are
    // never touched, only the pill filter.
    await user.click(screen.getByRole('button', { name: /Timepoints/i }))
    await user.click(screen.getByRole('button', { name: '5/28' }))

    await waitFor(() => {
      // Only the 25 real 5/27 tide readings should remain.
      expect(tideTraceFrom(capturedData)!.x!.length).toBe(25)
    })
  })
})
