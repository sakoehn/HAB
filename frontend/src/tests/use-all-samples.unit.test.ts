/**
 * use-all-samples.unit.test.ts
 * =============================
 * Unit tests for useAllSamples (utils/useAllSamples.ts).
 *
 * Caches /api/samples at MODULE scope (not React state) so every chart
 * shares one fetch, same pattern as useSolarTideData -- each test needs a
 * fresh copy of the module (vi.resetModules() + dynamic re-import) or
 * tests see whatever a previous test already cached.
 *
 * Coverage
 * --------
 *   fetches on mount and returns the sample list sorted chronologically
 *   drops rows with no resolvable timepoint (can't be placed on a timeline)
 *   a fetch failure surfaces as allSamplesError, not a thrown exception
 *   a second concurrent hook instance reuses the cache (no duplicate fetch)
 *   a failed fetch is retried by the next chart that mounts
 *
 * Run: npx vitest run src/tests/use-all-samples.unit.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

function errorResponse(status = 500, statusText = 'Server Error') {
  return { ok: false, status, statusText, json: async () => ({}) }
}

async function freshHook() {
  vi.resetModules()
  const mod = await import('../utils/useAllSamples')
  return mod.useAllSamples
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('useAllSamples', () => {
  it('fetches /api/samples on mount and returns entries sorted chronologically', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      expect(path).toBe('/api/samples?page_size=200')
      return jsonResponse({
        data: [
          { sample: 'S2', timepoint: { taxon_oid: 'S2', timepoint: '2', datetime: '5/28/21 9:00' } },
          { sample: 'S1', timepoint: { taxon_oid: 'S1', timepoint: '1', datetime: '5/27/21 13:00' } },
        ],
      })
    })
    const useAllSamples = await freshHook()
    const { result } = renderHook(() => useAllSamples())

    await waitFor(() => expect(result.current.allSamples).not.toBeNull())
    expect(result.current.allSamples).toEqual([
      { sample: 'S1', datetime: '5/27/21 13:00' },
      { sample: 'S2', datetime: '5/28/21 9:00' },
    ])
    expect(result.current.allSamplesLoading).toBe(false)
    expect(result.current.allSamplesError).toBeNull()
  })

  it('drops a row with no resolvable timepoint instead of crashing the sort', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({
      data: [
        { sample: 'S1', timepoint: { taxon_oid: 'S1', timepoint: '1', datetime: '5/27/21 13:00' } },
        { sample: 'BROKEN', timepoint: null },
      ],
    }))
    const useAllSamples = await freshHook()
    const { result } = renderHook(() => useAllSamples())

    await waitFor(() => expect(result.current.allSamples).not.toBeNull())
    expect(result.current.allSamples).toEqual([{ sample: 'S1', datetime: '5/27/21 13:00' }])
  })

  it('a fetch failure surfaces as allSamplesError, not a thrown exception', async () => {
    mockFetch.mockImplementation(async () => errorResponse(500))
    const useAllSamples = await freshHook()
    const { result } = renderHook(() => useAllSamples())

    await waitFor(() => expect(result.current.allSamplesError).not.toBeNull())
    expect(result.current.allSamples).toBeNull()
  })

  it('a second concurrent hook instance reuses the cache instead of re-fetching', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({
      data: [{ sample: 'S1', timepoint: { taxon_oid: 'S1', timepoint: '1', datetime: '5/27/21 13:00' } }],
    }))
    const useAllSamples = await freshHook()

    const first = renderHook(() => useAllSamples())
    await waitFor(() => expect(first.result.current.allSamples).not.toBeNull())
    const callsAfterFirstMount = mockFetch.mock.calls.length

    renderHook(() => useAllSamples())
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirstMount)
  })

  it('a failed fetch is retried by the next chart that mounts', async () => {
    mockFetch.mockImplementationOnce(async () => errorResponse(500))
    mockFetch.mockImplementation(async () => jsonResponse({
      data: [{ sample: 'S1', timepoint: { taxon_oid: 'S1', timepoint: '1', datetime: '5/27/21 13:00' } }],
    }))
    const useAllSamples = await freshHook()

    const first = renderHook(() => useAllSamples())
    await waitFor(() => expect(first.result.current.allSamplesError).not.toBeNull())

    const second = renderHook(() => useAllSamples())
    await waitFor(() => expect(second.result.current.allSamples).toEqual([{ sample: 'S1', datetime: '5/27/21 13:00' }]))
    expect(second.result.current.allSamplesError).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
