/**
 * use-copy-id.unit.test.ts
 * =========================
 * Unit tests for the useCopyId hook (hooks/useCopyId.ts).
 *
 * Coverage
 * --------
 *   copiedId starts null
 *   copy() writes the id to the clipboard
 *   copy() sets copiedId to the copied id
 *   copiedId resets to null after 1.5s
 *   copying a second id before the timeout replaces copiedId immediately
 *   copy is referentially stable across renders (useCallback)
 *
 * Run: npx vitest run src/tests/use-copy-id.unit.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useCopyId } from '../hooks/useCopyId'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useCopyId', () => {
  it('copiedId starts as null', () => {
    const { result } = renderHook(() => useCopyId())
    expect(result.current.copiedId).toBeNull()
  })

  it('copy() writes the id to the clipboard', async () => {
    const { result } = renderHook(() => useCopyId())
    await act(async () => {
      result.current.copy('K00001')
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('K00001')
  })

  it('copy() sets copiedId to the copied id', async () => {
    const { result } = renderHook(() => useCopyId())
    await act(async () => {
      result.current.copy('COG0055')
    })
    expect(result.current.copiedId).toBe('COG0055')
  })

  it('copiedId resets to null after 1.5s', async () => {
    const { result } = renderHook(() => useCopyId())
    await act(async () => {
      result.current.copy('K00001')
    })
    expect(result.current.copiedId).toBe('K00001')

    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(result.current.copiedId).toBeNull()
  })

  it('copiedId does not reset before 1.5s elapses', async () => {
    const { result } = renderHook(() => useCopyId())
    await act(async () => {
      result.current.copy('K00001')
    })

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.copiedId).toBe('K00001')
  })

  it('copying a second id before the timeout replaces copiedId', async () => {
    const { result } = renderHook(() => useCopyId())
    await act(async () => {
      result.current.copy('K00001')
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
      result.current.copy('COG0055')
    })
    expect(result.current.copiedId).toBe('COG0055')
  })

  it('copy callback is referentially stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useCopyId())
    const firstCopy = result.current.copy
    rerender()
    expect(result.current.copy).toBe(firstCopy)
  })
})
