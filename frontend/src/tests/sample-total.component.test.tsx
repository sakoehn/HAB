/**
 * sample-total.component.test.tsx
 * ================================
 * The "N of M samples" counts and the Mappings sample field use the real
 * number of samples from /api/samples, not a fixed 128. Here the dataset
 * has 3 samples.
 *
 * useAllSamples caches at module scope, so each test re-imports fresh
 * modules (vi.resetModules) with /api/samples mocked.
 *
 * Run: npx vitest run src/tests/sample-total.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

const THREE_SAMPLES = ['s1', 's2', 's3'].map((s, i) => ({
  sample: s, timepoint: { taxon_oid: s, timepoint: `T${i}`, datetime: `5/27/21 ${8 + 4 * i}:00` },
}))

beforeEach(() => {
  vi.resetModules()
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/samples')) return Promise.resolve(jsonResponse({ data: THREE_SAMPLES }))
    return Promise.resolve(jsonResponse({ data: [], total: 0 }))
  })
})

function row(sampleCount: number) {
  return {
    source: 'cog', sample: '', timepoint: null, annotation_id: 'COG0001',
    name: 'Chaperonin GroEL', value: {}, mean_egc: 100, sample_count: sampleCount,
  }
}

async function renderList(sampleCount: number) {
  const { LeftResultList } = await import('../components/annotations/LeftResultList')
  render(
    <LeftResultList
      rows={[row(sampleCount)]} total={1} termLabel="groel"
      checkedKeys={new Set()} seriesCache={{}} rightCardKeys={new Set()} copiedId={null}
      onCopy={vi.fn()} onToggleCheck={vi.fn()} onAddSingle={vi.fn()}
      onAddSelected={vi.fn()} onGroupSelected={vi.fn()}
    />,
  )
}

describe('counts use the real number of samples', () => {
  it('result list shows (2/3) for an annotation detected in 2 of 3 samples', async () => {
    await renderList(2)
    expect(await screen.findByText('(2/3)')).toBeInTheDocument()
    expect(screen.getByTitle('Mean when detected, across 2 of 3 samples')).toBeInTheDocument()
  })

  it('result list shows no count for an annotation detected in all 3', async () => {
    await renderList(3)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/api/samples?page_size=200', expect.anything()))
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByText(/\(3\/3\)|\(3\/128\)/)).not.toBeInTheDocument()
  })

  it('Mappings sample field allows up to the real number of samples', async () => {
    const user = userEvent.setup()
    const { useAllSamples } = await import('../utils/useAllSamples')
    const { MappingsPanel } = await import('../components/mappings/MappingsPanel')
    // Load the sample list first, as a chart on the same page would have.
    function Loader() { useAllSamples(); return null }
    const { unmount } = render(<Loader />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    unmount()

    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await user.click(screen.getByRole('button', { name: /View Annotation Mappings/i }))
    const field = await screen.findByRole('spinbutton')
    expect(field).toHaveAttribute('max', '3')
    expect(field).toHaveValue(3)
  })
})
