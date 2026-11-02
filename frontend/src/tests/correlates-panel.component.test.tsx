/**
 * correlates-panel.component.test.tsx
 * =====================================
 * Component tests for CorrelatesPanel (components/correlates/CorrelatesPanel.tsx)
 * -- the method/default selection, the full ranked list with its
 * significance marking, and the "keep going" retry behavior.
 *
 * A cold family can outlast the panel's client-side request timeout while
 * the server keeps computing in the background (correlation_family_endpoint
 * is a synchronous route, run in a thread pool that keeps going after the
 * client gives up, caching each candidate as it's scored). So a timeout or
 * 5xx re-issues the request instead of showing a dead-end error -- each
 * retry benefits from whatever the background computation already cached.
 *
 * Run: npx vitest run src/tests/correlates-panel.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CorrelatesPanel } from '../components/correlates/CorrelatesPanel'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data }
}

// What apiFetch's own AbortController actually produces on a real timeout
// -- a plain `new Error('timed out')` is indistinguishable from a hard 4xx
// failure to the retry logic, so it doesn't retry. Tests that mean
// to simulate a genuine timeout must reject with this instead.
function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function httpError(status: number, statusText: string) {
  return new Error(`${status} ${statusText}`)
}

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Opening the panel fetches once under the default method (spearman).
// That setup fetch is consumed with a harmless response and cleared from
// the mock's call history, so a caller's own mockFetch queue (configured
// AFTER calling this, then followed by selectAnotherMethod) counts only
// the attempts it actually cares about. Selecting a different method is
// what triggers the new fetch -- clicking the already-selected pill is a
// same-value setState no-op React won't re-fetch for.
async function openPanel() {
  const user = userEvent.setup()
  mockFetch.mockResolvedValueOnce(jsonResponse([]))
  await user.click(screen.getByRole('button', { name: /Find Correlates/i }))
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
  mockFetch.mockClear()
  return user
}

async function selectAnotherMethod(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'log_pearson' }))
}

function row(catalog_id: number, annotation_id: string, r: number, q: number) {
  return {
    catalog_id, annotation_id, name: 'x', depth: 2, r, p: q, q,
    significant: q < 0.05, lag_samples: 0, lag_hours: 0, n_pairs: 128,
  }
}

describe('CorrelatesPanel — methods', () => {
  it('fetches with method=spearman the first time the panel opens', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)

    await userEvent.setup().click(screen.getByRole('button', { name: /Find Correlates/i }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    const [url] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('method=spearman')
  })

  it('offers spearman, log_pearson and raw_pearson, with spearman selected', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)

    await userEvent.setup().click(screen.getByRole('button', { name: /Find Correlates/i }))
    await waitFor(() => screen.getByRole('button', { name: 'spearman' }))

    expect(screen.getByRole('button', { name: 'spearman' }).className).toContain('on')
    expect(screen.getByRole('button', { name: 'log_pearson' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'raw_pearson' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'circular_shift' })).not.toBeInTheDocument()
  })
})

describe('CorrelatesPanel — keeps retrying instead of failing on timeout', () => {
  // The removed circular_shift default showed a "this method is slower"
  // message as soon as the panel opened. No method is slow any more, so a
  // first attempt -- including the one the panel fires on open -- shows
  // only the loading skeleton; any message waits for a real retry.
  it('shows no extra message while the first search runs, for the default or any other method', async () => {
    mockFetch.mockReturnValue(new Promise(() => {})) // never resolves -- stays in 'loading'
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Find Correlates/i }))

    for (const method of ['spearman', 'log_pearson', 'raw_pearson']) {
      if (method !== 'spearman') await user.click(screen.getByRole('button', { name: method }))
      expect(await screen.findByText(/computing correlations/i)).toBeInTheDocument()
      expect(screen.queryByText(/slower|can take a while|still working/i)).not.toBeInTheDocument()
    }
  })

  it('automatically retries on failure and eventually succeeds, without ever showing an error', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    // Fails twice (simulating two 10-minute client timeouts while the
    // server keeps computing), then succeeds on the third attempt.
    mockFetch
      .mockRejectedValueOnce(abortError())
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(jsonResponse({
        results: [row(1, 'COG0001', 0.9, 0.02)], significant_count: 1, tested_count: 1,
      }))
    await selectAnotherMethod(user)

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('COG0001')).toBeInTheDocument()
    expect(screen.queryByText(/taking longer than usual/i)).not.toBeInTheDocument()
  })

  // The elapsed-time text reflects real wall-clock time (Date.now()), not
  // retryAttempt * 10 (which would assume every retry consumed the full
  // 10-minute timeout regardless of how long it actually took) -- Date.now() is mocked to advance by
  // exactly 10 real minutes across the one retry here, so "about 10 min"
  // is a genuine measurement, not a restated assumption.
  it('shows live elapsed-time text reflecting real wall-clock time, once a retry has happened', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    mockFetch
      .mockImplementationOnce(() => {
        now += 10 * 60_000 // simulate 10 real minutes passing before the timeout fires
        return Promise.reject(abortError())
      })
      .mockReturnValue(new Promise(() => {})) // second attempt hangs -- stays in 'loading'
    await selectAnotherMethod(user)

    expect(await screen.findByText(/still working — about 10 min so far/i)).toBeInTheDocument()
  })

  it('only shows a real error after exhausting all retries, with the real elapsed time', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    mockFetch.mockImplementation(() => {
      now += 10 * 60_000 // each of the 12 retryable attempts "takes" 10 real minutes
      return Promise.reject(abortError())
    })
    await selectAnotherMethod(user)

    // 1 initial attempt + MAX_CIRCULAR_SHIFT_RETRIES (12) retries = 13 calls
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(13), { timeout: 10000 })
    // 12 retryable attempts x 10 real minutes each = 120 minutes = 2 hours.
    const message = await screen.findByText(/taking longer than usual/i)
    expect(message.textContent).toMatch(/about 120 minutes/i)
    expect(message.textContent).toMatch(/still working on it/i)
    expect(message.textContent).toMatch(/try again in a few minutes/i)
  }, 15000)

  // A real 4xx (not a timeout) is a hard, immediate failure -- must
  // not be retried 12 times back-to-back before giving up, and the real
  // HTTP status must be surfaced instead of a fabricated "hours of
  // trying" message that implies retries actually happened.
  it('does not retry a real 4xx error, and surfaces the real HTTP status instead of a fabricated retry duration', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    mockFetch.mockRejectedValue(httpError(422, 'Unprocessable Entity'))
    await selectAnotherMethod(user)

    await waitFor(() => expect(screen.getByText(/correlation failed/i)).toBeInTheDocument())
    expect(mockFetch).toHaveBeenCalledTimes(1) // no retries at all
    expect(screen.getByText(/HTTP 422/)).toBeInTheDocument()
    expect(screen.queryByText(/taking longer than usual/i)).not.toBeInTheDocument()
  })

  // A 5xx IS worth retrying (a transient server-side issue, same as
  // a real timeout) -- distinct from the 4xx case above.
  it('does retry a 5xx error the same way as a timeout', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    mockFetch
      .mockRejectedValueOnce(httpError(503, 'Service Unavailable'))
      .mockResolvedValueOnce(jsonResponse({
        results: [], significant_count: 0, tested_count: 0,
      }))
    await selectAnotherMethod(user)

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
  })

  it('a non-retryable error (no response at all) still fails immediately, for any method', async () => {
    // A plain network error isn't a timeout or a 5xx, so it isn't
    // "still working" -- it's shown straight away.
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Find Correlates/i }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    mockFetch.mockReset()
    mockFetch.mockRejectedValue(new Error('network error'))
    await user.click(screen.getByRole('button', { name: 'log_pearson' }))

    expect(await screen.findByText(/check server connection/i)).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('CorrelatesPanel — full ranked list with significance marked', () => {
  async function openWith(response: unknown) {
    render(<CorrelatesPanel annotationId="K00001" source="kegg" onAddAnnotation={vi.fn()} />)
    mockFetch.mockResolvedValueOnce(jsonResponse(response))
    await userEvent.click(screen.getByRole('button', { name: /Find Correlates/i }))
  }

  it('shows non-significant candidates too, with only the significant q marked', async () => {
    await openWith({
      results: [row(1, 'COG0001', 0.92, 0.001), row(2, 'COG0002', 0.61, 0.4)],
      significant_count: 1, tested_count: 2,
    })

    const sigQ = await screen.findByText('q=0.001')
    const nsQ = screen.getByText('q=0.400')
    expect(sigQ.className).toContain('corr-stat-sig')
    expect(nsQ.className).not.toContain('corr-stat-sig')
    expect(nsQ.className).toContain('corr-stat-ns')
    expect(screen.getByText('COG0002')).toBeInTheDocument()
  })

  it('says how many of the tested candidates are significant', async () => {
    await openWith({
      results: [row(1, 'COG0001', 0.92, 0.001), row(2, 'COG0002', 0.61, 0.4)],
      significant_count: 1, tested_count: 2,
    })

    expect(await screen.findByText(/1 of 2 significant/)).toBeInTheDocument()
    expect(screen.getByText(/ranked by \|r\|/)).toBeInTheDocument()
  })

  it('says so when nothing is significant, while still listing the candidates', async () => {
    await openWith({
      results: [row(2, 'COG0002', 0.61, 0.4)],
      significant_count: 0, tested_count: 1,
    })

    expect(await screen.findByText(/0 of 1 significant/)).toBeInTheDocument()
    expect(screen.getByText('COG0002')).toBeInTheDocument()
  })

  it('discloses the true number tested when `limit` cut the list shorter', async () => {
    await openWith({
      results: [row(1, 'COG0001', 0.92, 0.001)],
      significant_count: 3, tested_count: 4637,
    })

    expect(await screen.findByText(/showing top 1 of 4,637 tested/)).toBeInTheDocument()
    expect(screen.getByText(/3 of 4,637 significant/)).toBeInTheDocument()
  })

  it('does not show the cap disclosure when every tested candidate is already shown', async () => {
    await openWith({
      results: [row(1, 'COG0001', 0.92, 0.001)],
      significant_count: 1, tested_count: 1,
    })

    await screen.findByText(/COG0001/)
    expect(screen.queryByText(/showing top/)).not.toBeInTheDocument()
  })

  it('says no candidates could be scored when the list is empty', async () => {
    await openWith({ results: [], significant_count: 0, tested_count: 0 })

    expect(await screen.findByText(/no candidates could be scored/i)).toBeInTheDocument()
  })

  it('never shows a pre-screen notice', async () => {
    await openWith({
      results: [row(1, 'COG0001', 0.92, 0.001)],
      significant_count: 1, tested_count: 1,
    })

    await screen.findByText(/COG0001/)
    expect(screen.queryByText(/pre-screen/i)).not.toBeInTheDocument()
  })
})

describe('CorrelatesPanel — explains that a first search can be slow', () => {
  it('the Method row has a help tooltip saying the first search of a combination can take a while', async () => {
    mockFetch.mockResolvedValue(jsonResponse([]))
    const user = userEvent.setup()
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Find Correlates/i }))
    const methodRow = (await screen.findByText('Method:')).parentElement!
    await user.click(within(methodRow).getByTitle('Help'))
    await waitFor(() => expect(screen.getByText(/first time/i)).toBeInTheDocument())
    expect(screen.getByText(/first time/i).textContent).toMatch(/saved|cached/i)
  })
})

describe('CorrelatesPanel — every method keeps trying while a first search is slow', () => {
  it('retries after a timeout, says it is still working, and shows the results', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Find Correlates/i }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    let release!: () => void
    mockFetch.mockReset()
    mockFetch
      .mockRejectedValueOnce(httpError(504, 'Gateway Time-out'))
      .mockImplementationOnce(() => new Promise(resolve => {
        release = () => resolve(jsonResponse({
          results: [row(1, 'COG0001', 0.9, 0.02)], significant_count: 1, tested_count: 1,
        }))
      }))
    await user.click(screen.getByRole('button', { name: 'log_pearson' }))

    expect(await screen.findByText(/still working/i)).toBeInTheDocument()
    expect(screen.queryByText(/correlation failed/i)).not.toBeInTheDocument()
    release()
    expect(await screen.findByText('COG0001')).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('after all retries says it is still working, without suggesting another method', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Find Correlates/i }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    mockFetch.mockReset()
    mockFetch.mockRejectedValue(httpError(504, 'Gateway Time-out'))
    await user.click(screen.getByRole('button', { name: 'raw_pearson' }))

    const message = await screen.findByText(/taking longer than usual/i, {}, { timeout: 10000 })
    expect(message.textContent).toMatch(/try again in a few minutes/i)
    expect(message.textContent).not.toMatch(/try spearman/i)
    expect(mockFetch).toHaveBeenCalledTimes(13)
  }, 15000)
})
