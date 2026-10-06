/**
 * multi-egc-chart-gaps.component.test.tsx
 * ==========================================
 * F1 (docs/AUDIT-2026-10-05.md): MultiEgcChart's own baseRows used to be
 * built only from timepoints where at least one displayed series had data,
 * and connectgaps was hardcoded true -- so a real non-detection in one
 * series, at a timepoint another series DID have data for, silently drew a
 * straight line across it instead of a break. A timepoint where NO
 * displayed series had any data didn't exist in the chart's x-axis at all.
 *
 * This is the same W21 failure mode EgcChart already fixed (confirmed via
 * its own allPoints/connectgaps:false) -- MultiEgcChart is the sibling the
 * audit found still broken. Needs its own file (not multi-egc-chart.
 * component.test.tsx) because it mocks react-plotly.js/factory to capture
 * the real `data` prop passed to <Plot>, the same technique
 * tide-trace-native-resolution.component.test.tsx already established --
 * real Plotly renders no meaningful SVG under jsdom, so connectgaps and the
 * actual y-array (including explicit nulls) can only be checked this way.
 *
 * Run: npx vitest run src/tests/multi-egc-chart-gaps.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import type { AnnotationItem } from '../types'

// ── Capture what MultiEgcChart actually passes to <Plot data={...}> ───────
let capturedData: Array<{ name?: string; x?: unknown[]; y?: unknown[]; connectgaps?: boolean }> = []

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

// 3 real samples -- detected at the first and last, a genuine gap at the
// middle one (8:00), the exact shape F1 describes.
const ALL_SAMPLES = ['s1', 's2', 's3'].map((sample, i) => ({
  sample,
  timepoint: { taxon_oid: sample, timepoint: `T${i}`, datetime: `5/27/21 ${8 * i}:00` },
}))

function makePoint(datetime: string, egc: number): AnnotationItem {
  return {
    source: 'cog', sample: 's1', annotation_id: 'A', name: 'A',
    timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime },
    // norm_egc included -- the chart opens on Relative Abundance (metric
    // defaults to 'norm_egc'), which reads this field, not raw egc.
    value: { egc, norm_egc: egc / 100000 },
  }
}

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

describe('MultiEgcChart — real detection gaps are drawn as breaks, not bridged (F1)', () => {
  it('unions the full sample timeline and sets an explicit null at an undetected timepoint', async () => {
    const series = [{
      id: 'A', annotationId: 'A', name: 'A', color: '#000', source: 'cog',
      // Detected at 0:00 and 16:00 only -- genuinely missing at 8:00.
      data: [makePoint('5/27/21 0:00', 100), makePoint('5/27/21 16:00', 300)],
    }]

    render(<MultiEgcChart series={series} dateFrom="" dateTo="" />)

    await waitFor(() => {
      expect(capturedData.length).toBeGreaterThan(0)
      const trace = capturedData.find(t => t.name === 'A')
      expect(trace).toBeDefined()
      // The real sample timeline has 3 points -- the chart's x-axis must
      // include all 3, not just the 2 the series was actually detected at.
      expect(trace!.x).toHaveLength(3)
    })

    const trace = capturedData.find(t => t.name === 'A')!
    expect(trace.connectgaps).toBe(false)
    // egc metric defaults off (chart opens on Relative Abundance), but the
    // gap/null placement is identical regardless of metric -- Relative
    // Abundance just divides the same positions through a per-sample total.
    expect(trace.y![1]).toBeNull()
  })
})
