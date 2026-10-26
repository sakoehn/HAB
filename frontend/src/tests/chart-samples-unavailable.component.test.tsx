/**
 * chart-samples-unavailable.component.test.tsx
 * =============================================
 * Compare's chart (MultiEgcChart) and the group chart (GroupedEgcChart) use
 * the full sample list to leave a gap where an annotation wasn't detected.
 * When that list fails to load they can't, so -- like EgcChart -- they must
 * say so rather than silently drawing straight across the missing samples.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import { GroupedEgcChart } from '../components/charts/GroupedEgcChart'
import type { AnnotationItem } from '../types'

vi.mock('../utils/useAllSamples', () => ({
  useAllSamples: () => ({ allSamples: null, allSamplesLoading: false, allSamplesError: 'Error: 500' }),
}))
vi.mock('react-plotly.js/factory', () => ({ default: () => () => null }))
vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))

function point(id: string, datetime: string, egc: number): AnnotationItem {
  return {
    source: 'cog', sample: 's1', annotation_id: id, name: id,
    timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime },
    value: { egc, norm_egc: egc / 1e5 },
  }
}

const WARNING = /full sample timeline unavailable/i

describe('charts warn when the full sample list is unavailable', () => {
  it('MultiEgcChart', () => {
    render(
      <MultiEgcChart
        series={[{ id: 'a', annotationId: 'COG1', name: 'COG1', color: '#000', source: 'cog', data: [point('COG1', '5/27/21 8:00', 10)] }]}
        dateFrom="" dateTo=""
      />,
    )
    expect(screen.getByText(WARNING)).toBeInTheDocument()
  })

  it('GroupedEgcChart', () => {
    render(
      <GroupedEgcChart
        groupLabel="G"
        allSeries={[{ annotationId: 'COG1', name: 'COG1', color: '#000', data: [point('COG1', '5/27/21 8:00', 10)] }]}
      />,
    )
    expect(screen.getByText(WARNING)).toBeInTheDocument()
  })
})
