/**
 * correlates-panel.component.test.tsx
 * =====================================
 * Component tests for CorrelatesPanel (components/correlates/CorrelatesPanel.tsx)
 * -- covers the circular_shift "keep going" behavior added this session.
 *
 * circular_shift runs a full permutation test (1,000 reshuffles per
 * candidate) and can take minutes to hours on a large family -- long
 * enough that the panel's 10-minute client-side request timeout routinely
 * fires while the server is still legitimately computing in the
 * background (correlation_family_endpoint is a synchronous route, run in
 * a thread pool that keeps going even after the client gives up, caching
 * each candidate individually as it's scored). Before this fix, a single
 * timeout showed a dead-end "Correlation failed" error requiring the user
 * to notice and manually retry. Now, for circular_shift specifically, a
 * timeout automatically re-issues the request (up to
 * MAX_CIRCULAR_SHIFT_RETRIES times) instead of surfacing an error --
 * each retry benefits from whatever the background computation already
 * cached, so it's strictly making progress, not just spinning.
 *
 * Run: npx vitest run src/tests/correlates-panel.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CorrelatesPanel } from '../components/correlates/CorrelatesPanel'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data }
}

beforeEach(() => {
  mockFetch.mockReset()
})

// Opening the panel fetches once with the default method (spearman),
// before circular_shift is ever selected -- consumed here with a
// harmless resolved response and then cleared from mock call history, so
// a caller's own mockFetch queue (configured AFTER calling this, then
// followed by selecting circular_shift) counts only the circular_shift
// attempts it actually cares about, not this unrelated setup fetch.
async function openPanel() {
  const user = userEvent.setup()
  mockFetch.mockResolvedValueOnce(jsonResponse([]))
  await user.click(screen.getByRole('button', { name: /Find Correlates/i }))
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
  mockFetch.mockClear()
  return user
}

async function selectCircularShift(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'circular_shift' }))
}

describe('CorrelatesPanel — circular_shift keeps retrying instead of failing on timeout', () => {
  it('shows a first-attempt loading message, not shown for the default method', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    mockFetch.mockReturnValue(new Promise(() => {})) // never resolves -- stays in 'loading'
    await selectCircularShift(user)
    expect(await screen.findByText(/slower and can take a while/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'spearman' }))
    expect(screen.queryByText(/slower and can take a while/i)).not.toBeInTheDocument()
  })

  it('automatically retries on failure and eventually succeeds, without ever showing an error', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    // Fails twice (simulating two 10-minute client timeouts while the
    // server keeps computing), then succeeds on the third attempt.
    mockFetch
      .mockRejectedValueOnce(new Error('timed out'))
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce(jsonResponse([
        { catalog_id: 1, annotation_id: 'COG0001', name: 'x', depth: 2, r: 0.9, p: 0.01, q: 0.02, lag_samples: 0, lag_hours: 0, n_pairs: 128 },
      ]))
    await selectCircularShift(user)

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('COG0001')).toBeInTheDocument()
    expect(screen.queryByText(/still not done/i)).not.toBeInTheDocument()
  })

  it('shows live elapsed-time text once at least one retry has happened', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    mockFetch
      .mockRejectedValueOnce(new Error('timed out'))
      .mockReturnValue(new Promise(() => {})) // second attempt hangs -- stays in 'loading'
    await selectCircularShift(user)

    expect(await screen.findByText(/still working — about 10 min so far/i)).toBeInTheDocument()
  })

  it('only shows a real error after exhausting all retries, with method-specific guidance', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    mockFetch.mockRejectedValue(new Error('timed out'))
    await selectCircularShift(user)

    // 1 initial attempt + MAX_CIRCULAR_SHIFT_RETRIES (12) retries = 13 calls
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(13), { timeout: 10000 })
    expect(await screen.findByText(/still not done after about 2 hours/i)).toBeInTheDocument()
    expect(screen.getByText(/try spearman/i)).toBeInTheDocument()
  }, 15000)

  it('still fails immediately (no retry) for the default, non-permutation method', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Find Correlates/i }))

    expect(await screen.findByText(/check server connection/i)).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
