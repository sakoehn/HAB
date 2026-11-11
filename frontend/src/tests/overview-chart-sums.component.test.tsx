/**
 * overview-chart-sums.component.test.tsx
 * =======================================
 * Dataset Overview's "Load time series" chart draws one line per parent
 * group: at each sample, the sum over the group's members detected there.
 * This checks the y-values the chart actually hands to Plotly, not just the
 * summing helper on its own.
 *
 * Captures the real `data` prop passed to <Plot> (same technique as
 * grouped-egc-chart-gaps.component.test.tsx).
 *
 * Run: npx vitest run src/tests/overview-chart-sums.component.test.tsx
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DatasetOverviewPanel } from '../pages/ExplorePage'

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

const SAMPLES = [
  { sample: 's1', timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '5/27/21 8:00' } },
  { sample: 's2', timepoint: { taxon_oid: 's2', timepoint: 'T2', datetime: '5/27/21 12:00' } },
]

function point(id: string, sample: string, egc: number, norm: number) {
  const tp = SAMPLES.find(s => s.sample === sample)!.timepoint
  return { source: 'cog', sample, annotation_id: id, name: id, timepoint: tp, value: { egc, norm_egc: norm } }
}

// COG0001 is in both samples; COG0002 only in s1.
const SERIES: Record<string, unknown[]> = {
  COG0001: [point('COG0001', 's1', 10, 0.1), point('COG0001', 's2', 20, 0.2)],
  COG0002: [point('COG0002', 's1', 5, 0.05)],
}

describe('Dataset Overview chart sums each group per sample', () => {
  it("draws a group's line as the sum of its members detected at each sample", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/samples')) return Promise.resolve(jsonResponse({ data: SAMPLES }))
      if (url.includes('/api/annotations/top'))
        return Promise.resolve(jsonResponse({
          data: [
            { annotation_id: 'COG0001', name: 'COG0001', parent: 'E', mean_egc: 15, max_egc: 20, sample_count: 2 },
            { annotation_id: 'COG0002', name: 'COG0002', parent: 'E', mean_egc: 5, max_egc: 5, sample_count: 1 },
          ],
          sample_count: 2,
        }))
      if (url.includes('/api/series/annotations')) {
        const id = new URL(url, 'http://x').searchParams.get('annotation_id')!
        return Promise.resolve(jsonResponse({ data: SERIES[id] ?? [] }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    const user = userEvent.setup()
    render(<DatasetOverviewPanel resetKey={0} dataDateRange={null} />)
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'cog')
    await user.click(screen.getByRole('button', { name: /Load Overview/i }))
    await user.click(await screen.findByRole('button', { name: /Load time series/i }))

    // The chart opens on Relative Abundance: s1 = 0.1 + 0.05, s2 = 0.2.
    await waitFor(() => {
      const line = capturedData.find(t => t.y?.length === 2)
      expect(line?.y?.map(v => Number((v as number).toFixed(6)))).toEqual([0.15, 0.2])
    })
  })
})
