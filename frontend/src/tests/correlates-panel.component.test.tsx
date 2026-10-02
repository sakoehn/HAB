/**
 * correlates-panel.component.test.tsx
 * =====================================
 * Component tests for CorrelatesPanel (components/correlates/CorrelatesPanel.tsx)
 * -- covers the circular_shift "keep going" behavior added this session.
 *
 * circular_shift runs a full permutation test (CR8, docs/AUDIT-2026-09-22.md:
 * exhaustively over every valid shift beyond the lag window, ~115 of them
 * at the real n=128, not a tunable sample count) and can still take real
 * time on a large family -- long enough that the panel's 10-minute
 * client-side request timeout can fire while the server is still
 * legitimately computing in the
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
import { render, screen, waitFor, within } from '@testing-library/react'
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

// CR2 (docs/AUDIT-2026-09-22.md): the panel now defaults to
// method=circular_shift itself (not spearman) -- opening it fetches once
// immediately under whatever the default is. This helper then explicitly
// clicks 'spearman' to force a KNOWN, non-circular_shift baseline
// regardless of what that default happens to be, so selectCircularShift
// below always produces a genuine method transition (and therefore a
// real new fetch -- the panel's useEffect depends on `method`, and
// clicking a method pill that's already selected is a same-value setState
// no-op React won't re-render/re-fetch for). Both setup fetches are
// consumed here with harmless resolved responses and cleared from mock
// call history, so a caller's own mockFetch queue (configured AFTER
// calling this, then followed by selecting circular_shift) counts only
// the circular_shift attempts it actually cares about.
async function openPanel() {
  const user = userEvent.setup()
  mockFetch.mockResolvedValueOnce(jsonResponse([]))
  await user.click(screen.getByRole('button', { name: /Find Correlates/i }))
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
  mockFetch.mockResolvedValueOnce(jsonResponse([]))
  await user.click(screen.getByRole('button', { name: 'spearman' }))
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
  mockFetch.mockClear()
  return user
}

async function selectCircularShift(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'circular_shift' }))
}

// CR2 (docs/AUDIT-2026-09-22.md): the default method flipped from
// spearman (parametric, ignores autocorrelation) to circular_shift
// (CR8-fixed permutation test) -- confirmed <=5% false positives and
// >=80% power by direct simulation (test_correlation_math.py), so every
// user gets a statistically valid p-value by default now, not just the
// ones who know to switch methods.
describe('CorrelatesPanel — defaults to circular_shift (CR2)', () => {
  it('fetches with method=circular_shift the first time the panel opens, before any method is explicitly selected', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)

    await userEvent.setup().click(screen.getByRole('button', { name: /Find Correlates/i }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    const [url] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('method=circular_shift')
  })

  it('the circular_shift pill is visibly selected on open, not spearman', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)

    await userEvent.setup().click(screen.getByRole('button', { name: /Find Correlates/i }))
    await waitFor(() => screen.getByRole('button', { name: 'circular_shift' }))

    expect(screen.getByRole('button', { name: 'circular_shift' }).className).toContain('on')
    expect(screen.getByRole('button', { name: 'spearman' }).className).not.toContain('on')
  })
})

describe('CorrelatesPanel — circular_shift keeps retrying instead of failing on timeout', () => {
  it('shows a first-attempt loading message, not shown for a non-permutation method', async () => {
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
      .mockResolvedValueOnce(jsonResponse({
        results: [
          { catalog_id: 1, annotation_id: 'COG0001', name: 'x', depth: 2, r: 0.9, p: 0.01, q: 0.02, lag_samples: 0, lag_hours: 0, n_pairs: 128 },
        ],
        prescreened: false, prescreen_pool_size: null, prescreen_top_n: null,
      }))
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

  it('still fails immediately (no retry) for a non-permutation method', async () => {
    // CR2 (docs/AUDIT-2026-09-22.md): the panel now defaults to
    // circular_shift itself, so this no-longer picks that behavior up
    // "for free" by just opening the panel -- explicitly selects a
    // fast/parametric method first to exercise the real thing under test
    // (retry is circular_shift-specific, not a property of whichever
    // method happens to be the default).
    mockFetch.mockResolvedValueOnce(jsonResponse([]))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Find Correlates/i }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    mockFetch.mockReset()
    mockFetch.mockRejectedValue(new Error('network error'))
    await user.click(screen.getByRole('button', { name: 'spearman' }))

    expect(await screen.findByText(/check server connection/i)).toBeInTheDocument()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('CorrelatesPanel — prescreen disclosure (CR8 follow-up)', () => {
  it('shows the prescreen banner and explanatory tooltip when the family was screened', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    mockFetch.mockResolvedValue(jsonResponse({
      results: [
        { catalog_id: 1, annotation_id: 'COG0001', name: 'x', depth: 2, r: 0.9, p: 0.01, q: 0.02, lag_samples: 0, lag_hours: 0, n_pairs: 128 },
      ],
      prescreened: true, prescreen_pool_size: 3559, prescreen_top_n: 200,
    }))
    await selectCircularShift(user)

    const banner = (await screen.findByText(/3,559 candidates/)).closest('.corr-empty') as HTMLElement
    expect(within(banner).getByText(/strongest 200/)).toBeInTheDocument()

    // The explanation of what prescreening means for the q-values shown --
    // HelpTooltip is click-to-reveal, so the real text only renders after clicking it.
    await user.click(within(banner).getByTitle('Help'))
    expect(await screen.findByText(/significance among the tested candidates, not the whole family/i)).toBeInTheDocument()
  })

  it('does not show the prescreen banner when the family was small enough not to need it', async () => {
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)
    const user = await openPanel()

    mockFetch.mockResolvedValue(jsonResponse({
      results: [], prescreened: false, prescreen_pool_size: null, prescreen_top_n: null,
    }))
    await selectCircularShift(user)

    await screen.findByText(/no significant correlates/i)
    expect(screen.queryByText(/candidates/)).not.toBeInTheDocument()
  })

  it('does not show the prescreen banner for non-circular_shift methods', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      results: [], prescreened: false, prescreen_pool_size: null, prescreen_top_n: null,
    }))
    render(<CorrelatesPanel annotationId="COG0055" source="cog" onAddAnnotation={vi.fn()} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Find Correlates/i }))

    await screen.findByText(/no significant correlates/i)
    expect(screen.queryByText(/candidates/)).not.toBeInTheDocument()
  })
})

describe('CorrelatesPanel — significant_count disclosure (CR10)', () => {
  it('discloses the true total when `limit` cut the list shorter', async () => {
    render(<CorrelatesPanel annotationId="K00001" source="kegg" onAddAnnotation={vi.fn()} />)
    mockFetch.mockResolvedValueOnce(jsonResponse({
      results: [
        { catalog_id: 1, annotation_id: 'COG0001', name: 'x', depth: 2, r: 0.9, p: 0.01, q: 0.02, lag_samples: 0, lag_hours: 0, n_pairs: 128 },
      ],
      significant_count: 2847,
      prescreened: false, prescreen_pool_size: null, prescreen_top_n: null,
    }))

    await userEvent.click(screen.getByRole('button', { name: /Find Correlates/i }))

    expect(await screen.findByText(/showing top 1 of 2,847 significant/)).toBeInTheDocument()
  })

  it('does not show the cap disclosure when every significant result is already shown', async () => {
    render(<CorrelatesPanel annotationId="K00001" source="kegg" onAddAnnotation={vi.fn()} />)
    mockFetch.mockResolvedValueOnce(jsonResponse({
      results: [
        { catalog_id: 1, annotation_id: 'COG0001', name: 'x', depth: 2, r: 0.9, p: 0.01, q: 0.02, lag_samples: 0, lag_hours: 0, n_pairs: 128 },
      ],
      significant_count: 1,
      prescreened: false, prescreen_pool_size: null, prescreen_top_n: null,
    }))

    await userEvent.click(screen.getByRole('button', { name: /Find Correlates/i }))

    await screen.findByText(/COG0001/)
    expect(screen.queryByText(/showing top/)).not.toBeInTheDocument()
  })
})
