/**
 * scaffold-chart-zero-samples.component.test.tsx
 * ===============================================
 * A scaffold summary only has rows for samples where the annotation has
 * scaffolds. The scaffold charts draw every other real sample at 0 (the
 * same value the CSV writes), not as a line straight across them.
 *
 * Captures the real `data` prop passed to <Plot> (same technique as
 * grouped-egc-chart-gaps.component.test.tsx) with /api/samples mocked.
 * Also checks the x-values: each sample's own local time as text, which
 * Plotly draws as written, never an epoch number it would place in the
 * viewer's own time zone.
 *
 * Run: npx vitest run src/tests/scaffold-chart-zero-samples.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

import { ScaffoldModal } from '../components/scaffolds/ScaffoldModal'
import { GroupScaffoldModal } from '../components/scaffolds/GroupScaffoldModal'
import { ScaffoldExplorePanel } from '../components/scaffolds/ScaffoldExplorePanel'

let capturedData: Array<{ x?: unknown[]; y?: unknown[] }> = []

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

const ALL_SAMPLES = [
  { sample: 's1', timepoint: { taxon_oid: 's1', timepoint: 'T0', datetime: '5/27/21 13:00' } },
  { sample: 's2', timepoint: { taxon_oid: 's2', timepoint: 'T1', datetime: '5/27/21 17:00' } },
  { sample: 's3', timepoint: { taxon_oid: 's3', timepoint: 'T2', datetime: '5/27/21 21:00' } },
]

const LOCAL_TIMES = ['2021-05-27 13:00:00', '2021-05-27 17:00:00', '2021-05-27 21:00:00']

// Scaffolds in s1 and s3 only.
const SUMMARY = [
  { sample: 's1', date: '5/27/21 13:00', scaffold_count: 3, gene_count: 4 },
  { sample: 's3', date: '5/27/21 21:00', scaffold_count: 5, gene_count: 7 },
]

beforeEach(() => {
  capturedData = []
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/samples')) return Promise.resolve(jsonResponse({ data: ALL_SAMPLES }))
    if (url.includes('/api/annotations/scaffolds/summary')) return Promise.resolve(jsonResponse({ data: SUMMARY, total: 2 }))
    return Promise.resolve(jsonResponse({}))
  })
})

describe('scaffold charts draw a sample with no scaffolds at 0', () => {
  it('ScaffoldModal', async () => {
    render(<ScaffoldModal annotationId="K02014" source="kegg" onClose={vi.fn()} />)
    await waitFor(() => expect(capturedData[0]?.y).toEqual([3, 0, 5]))
    expect(capturedData[0]?.x).toEqual(LOCAL_TIMES)
  })

  it('GroupScaffoldModal', async () => {
    render(
      <GroupScaffoldModal
        members={[{ annotationId: 'K02014', source: 'kegg', name: null }]}
        groupLabel="G"
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(capturedData[0]?.y).toEqual([3, 0, 5]))
    expect(capturedData[0]?.x).toEqual(LOCAL_TIMES)
  })

  it('ScaffoldExplorePanel', async () => {
    render(<ScaffoldExplorePanel initialTerms={[{ annotationId: 'K02014', source: 'kegg' }]} />)
    await waitFor(() => expect(capturedData[0]?.y).toEqual([3, 0, 5]))
    expect(capturedData[0]?.x).toEqual(LOCAL_TIMES)
  })
})
