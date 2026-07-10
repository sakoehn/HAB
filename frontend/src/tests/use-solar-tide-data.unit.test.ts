/**
 * use-solar-tide-data.unit.test.ts
 * =================================
 * Unit tests for useSolarTideData (utils/useSolarTideData.ts).
 *
 * The hook caches /api/sun-times and /api/tides at MODULE scope (not React
 * state) so every chart shares one fetch. That means each test needs a
 * fresh copy of the module — vi.resetModules() + a dynamic re-import — or
 * tests would see whatever the previous test already cached.
 *
 * Coverage
 * --------
 *   enabled=false never triggers a fetch
 *   enabled=true fetches both sun-times and tides
 *   sun-times and tides loading/error states are independent
 *   a second concurrent hook instance reuses the cache (no duplicate fetch)
 *
 * Run: npx vitest run src/tests/use-solar-tide-data.unit.test.ts
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
  const mod = await import('../utils/useSolarTideData')
  return mod.useSolarTideData
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('useSolarTideData', () => {
  it('does not fetch when enabled is false', async () => {
    const useSolarTideData = await freshHook()
    renderHook(() => useSolarTideData(false))
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetches both sun-times and tides when enabled', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/sun-times') return jsonResponse({ data: { sunrise: '06:00' } })
      if (path === '/api/tides')     return jsonResponse({ data: [{ t: '2021-01-01', v: 1.2 }] })
      throw new Error(`unexpected path: ${path}`)
    })
    const useSolarTideData = await freshHook()
    const { result } = renderHook(() => useSolarTideData(true))

    await waitFor(() => expect(result.current.sunTimes).not.toBeNull())
    expect(result.current.sunTimes).toEqual({ sunrise: '06:00' })
    expect(result.current.tides).toEqual([{ t: '2021-01-01', v: 1.2 }])
    expect(result.current.sunTimesLoading).toBe(false)
    expect(result.current.tidesLoading).toBe(false)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('a sun-times fetch failure does not affect tides, and vice versa', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/sun-times') return errorResponse(500)
      if (path === '/api/tides')     return jsonResponse({ data: [] })
      throw new Error(`unexpected path: ${path}`)
    })
    const useSolarTideData = await freshHook()
    const { result } = renderHook(() => useSolarTideData(true))

    await waitFor(() => expect(result.current.sunTimesError).not.toBeNull())
    expect(result.current.sunTimes).toBeNull()
    expect(result.current.tidesError).toBeNull()
    expect(result.current.tides).toEqual([])
  })

  it('a second concurrent hook instance reuses the cache instead of re-fetching', async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/api/sun-times') return jsonResponse({ data: { sunrise: '06:00' } })
      if (path === '/api/tides')     return jsonResponse({ data: [] })
      throw new Error(`unexpected path: ${path}`)
    })
    const useSolarTideData = await freshHook()

    const first = renderHook(() => useSolarTideData(true))
    await waitFor(() => expect(first.result.current.sunTimes).not.toBeNull())
    const callsAfterFirstMount = mockFetch.mock.calls.length

    renderHook(() => useSolarTideData(true))
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirstMount)
  })
})
