/**
 * dataset-overview-chart-date-filter.component.test.tsx
 * =========================================================
 * E3 (docs/AUDIT-2026-10-05.md): DatasetOverviewPanel's temporal chart
 * passed the live dateFrom/dateTo state into MultiEgcChart instead of
 * loadedParams (the snapshot of what was actually requested) -- every
 * sibling render site in this panel (the summary line, CSV filename,
 * yLabel) already reads loadedParams for the same W29 reason, but this
 * one call was still reading live state. Editing the date picker after
 * loading, without reloading, silently clipped the chart to the new
 * (unloaded) range while the summary line right above it still correctly
 * said "all dates".
 *
 * Needs its own file (not dataset-overview-panel.component.test.tsx)
 * because it mocks react-plotly.js/factory to capture the real `x` array
 * MultiEgcChart passes to <Plot> -- the same technique
 * multi-egc-chart-gaps.component.test.tsx already established -- since a
 * clipped chart is otherwise invisible under jsdom (no meaningful SVG).
 *
 * Run: npx vitest run src/tests/dataset-overview-chart-date-filter.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DatasetOverviewPanel } from '../pages/ExplorePage'
import type { TopAnnotation } from '../types'

// ── Capture what MultiEgcChart actually passes to <Plot data={...}> ───────
let capturedData: Array<{ name?: string; x?: unknown[] }> = []

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

function makeRow(id: string, parent: string, egc: number): TopAnnotation {
  return {
    annotation_id: id, name: id, parent, mean_egc: egc, max_egc: egc * 2, sample_count: 128,
  }
}

// 3 real points spread across most of the dataset -- far enough apart
// that a narrow live-picker range would only cover one of them.
const SERIES_ROWS = [
  { source: 'kegg', sample: 's1', annotation_id: 'K0', name: 'K0', timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '5/1/21 8:00' },  value: { egc: 10 } },
  { source: 'kegg', sample: 's2', annotation_id: 'K0', name: 'K0', timepoint: { taxon_oid: 's2', timepoint: 'T2', datetime: '5/15/21 8:00' }, value: { egc: 20 } },
  { source: 'kegg', sample: 's3', annotation_id: 'K0', name: 'K0', timepoint: { taxon_oid: 's3', timepoint: 'T3', datetime: '5/30/21 8:00' }, value: { egc: 30 } },
]

beforeEach(() => {
  capturedData = []
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/annotations/top'))
      return Promise.resolve(jsonResponse({ data: [makeRow('K0', 'group0', 100)], sample_count: 128 }))
    if (url.includes('/api/series/annotations'))
      return Promise.resolve(jsonResponse({ data: SERIES_ROWS }))
    return Promise.resolve(jsonResponse({}))
  })
})

describe('DatasetOverviewPanel — temporal chart stays at the loaded date range, not the live picker (E3)', () => {
  it('does not clip the chart when the date picker is edited after loading, without reloading', async () => {
    const user = userEvent.setup()
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)

    // Load Overview with NO date filter -- loadedParams.dateFrom/dateTo stay ''.
    await user.click(screen.getByRole('button', { name: /Load Overview/i }))
    await waitFor(() => screen.getByRole('button', { name: /Load time series/i }))
    await user.click(screen.getByRole('button', { name: /Load time series/i }))

    await waitFor(() => {
      expect(capturedData.length).toBeGreaterThan(0)
    })
    // All 3 real points present with no date filter applied.
    expect(capturedData[0].x).toHaveLength(3)

    // Edit the LIVE date picker to a narrow range covering only the
    // middle point, WITHOUT clicking Load Overview again.
    const dateInputs = document.querySelectorAll('input[type="date"]')
    await user.type(dateInputs[0], '2021-05-14')
    await user.type(dateInputs[1], '2021-05-16')

    // The chart must still show all 3 points -- it reads loadedParams
    // (still '' / ''), not the live picker that was just edited.
    expect(capturedData[0].x).toHaveLength(3)
  })
})
