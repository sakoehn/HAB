/**
 * egc-chart-visible-samples.component.test.tsx
 * ==============================================
 * EgcChart reports which samples it is currently drawing (after its date
 * range and Timepoints pill filters), so a caller's own summary -- the
 * Analyze card-header mean -- describes the same points as the chart.
 *
 * Run: npx vitest run src/tests/egc-chart-visible-samples.component.test.tsx
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { EgcChart } from '../components/charts/EgcChart'
import type { AnnotationItem } from '../types'

vi.mock('react-plotly.js/factory', () => ({
  default: () => () => null,
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
mockFetch.mockImplementation(() =>
  Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: async () => ({}) }),
)

function point(datetime: string, egc: number, sample: string): AnnotationItem {
  return {
    source: 'cog', sample, annotation_id: 'COG0001', name: 'GroEL',
    timepoint: { taxon_oid: sample, timepoint: 'T1', datetime },
    value: { egc, norm_egc: egc / 100000 },
  }
}

describe('EgcChart — reports the samples it is drawing', () => {
  it('reports every sample at first, then only those left after a Timepoints pill is turned off', async () => {
    const user = userEvent.setup()
    const onVisibleSamplesChange = vi.fn()
    render(
      <EgcChart
        data={[point('5/27/21 8:00', 100, 's1'), point('5/28/21 8:00', 110, 's2')]}
        annotationId="COG0001"
        annotationName="GroEL"
        source="cog"
        onVisibleSamplesChange={onVisibleSamplesChange}
      />,
    )
    await waitFor(() =>
      expect(onVisibleSamplesChange).toHaveBeenLastCalledWith(['s1', 's2']),
    )

    await user.click(screen.getByRole('button', { name: /Timepoints/i }))
    await user.click(screen.getByRole('button', { name: '5/28' }))

    await waitFor(() =>
      expect(onVisibleSamplesChange).toHaveBeenLastCalledWith(['s1']),
    )
  })
})
