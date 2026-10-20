/**
 * grouped-egc-chart-gaps.component.test.tsx
 * =============================================
 * GroupedEgcChart's summedPoints must include every real timepoint, even
 * one where every member was undetected (otherwise the trace would connect
 * across it and the header's point count would shrink), and must disclose
 * how many members each sum covers. E.g. members A (detected 0:00, 16:00)
 * and B (detected 0:00, 8:00): the 8:00 value is B alone, which would
 * otherwise look the same as 0:00's A+B.
 *
 * Needs its own file (not grouped-egc-chart.component.test.tsx, which has
 * no fetch/Plotly mocking and relies on that absence to keep its own
 * summing-correctness tests using exactly the series' own detected
 * samples) because it mocks react-plotly.js/factory to capture the real
 * `data` prop passed to <Plot> (same technique
 * tide-trace-native-resolution.component.test.tsx and multi-egc-chart-
 * gaps.component.test.tsx already established) and mocks /api/samples to
 * supply a real timeline with a genuine all-members-undetected gap.
 *
 * Run: npx vitest run src/tests/grouped-egc-chart-gaps.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { GroupedEgcChart } from '../components/charts/GroupedEgcChart'
import type { AnnotationItem } from '../types'

// ── Capture what GroupedEgcChart actually passes to <Plot data={...}> ─────
let capturedData: Array<{ name?: string; x?: unknown[]; y?: unknown[]; connectgaps?: boolean; customdata?: unknown[][] }> = []

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

// 4 real samples: a shared detection (0:00), a B-only point (8:00), an
// A-only point (16:00), and a genuine zero-detection gap (next day 0:00).
const ALL_SAMPLES = [
  { sample: 's1', timepoint: { taxon_oid: 's1', timepoint: 'T0', datetime: '5/27/21 0:00' } },
  { sample: 's2', timepoint: { taxon_oid: 's2', timepoint: 'T1', datetime: '5/27/21 8:00' } },
  { sample: 's3', timepoint: { taxon_oid: 's3', timepoint: 'T2', datetime: '5/27/21 16:00' } },
  { sample: 's4', timepoint: { taxon_oid: 's4', timepoint: 'T3', datetime: '5/28/21 0:00' } },
]

function makePoint(annotationId: string, datetime: string, egc: number): AnnotationItem {
  return {
    source: 'cog', sample: 's1', annotation_id: annotationId, name: annotationId,
    timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime },
    value: { egc },
  }
}

const selectRawEgc = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'EGC' }))

beforeEach(() => {
  capturedData = []
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/samples')) {
      return Promise.resolve(jsonResponse({ data: ALL_SAMPLES }))
    }
    return Promise.resolve(jsonResponse({}))
  })
})

describe('GroupedEgcChart — real detection gaps and the shifting member set are disclosed', () => {
  it('unions the full timeline, nulls a zero-detection timepoint, and never equates a partial sum with a full one', async () => {
    const user = userEvent.setup()
    render(
      <GroupedEgcChart
        groupLabel="Test Group"
        allSeries={[
          {
            annotationId: 'A', name: 'A', color: '#000',
            data: [makePoint('A', '5/27/21 0:00', 10), makePoint('A', '5/27/21 16:00', 30)],
          },
          {
            annotationId: 'B', name: 'B', color: '#000',
            data: [makePoint('B', '5/27/21 0:00', 5), makePoint('B', '5/27/21 8:00', 15)],
          },
        ]}
      />,
    )
    await selectRawEgc(user)

    await waitFor(() => {
      const trace = capturedData.find(t => t.name === 'Test Group')
      expect(trace).toBeDefined()
      // All 4 real samples, not just the 3 (or fewer) timepoints some
      // member happened to be detected at.
      expect(trace!.x).toHaveLength(4)
    })

    const trace = capturedData.find(t => t.name === 'Test Group')!
    // 0:00 = A+B (10+5=15), 8:00 = B alone (15), 16:00 = A alone (30),
    // next-day 0:00 = nobody detected (null) -- 0:00 and 8:00 are both "15", but one is a 2-member sum and
    // the other is 1-member, which only the customdata member count below
    // can actually tell apart.
    expect(trace.y).toEqual([15, 15, 30, null])
    expect(trace.customdata!.map(c => c[2])).toEqual([2, 1, 1, 0])

    // Header discloses the real denominator: 4 real timepoints, only 3 of
    // which had any member detected at all.
    expect(screen.getByText(/4 timepoints/)).toBeInTheDocument()
    expect(screen.getByText(/\(detected in 3\)/)).toBeInTheDocument()
  })
})
