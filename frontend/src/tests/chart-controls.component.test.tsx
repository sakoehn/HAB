/**
 * chart-controls.component.test.tsx
 * ====================================
 * Component tests for ChartControls (components/charts/ChartControls.tsx)
 * -- the shared metric/standardize/smooth/overlay control bar used by all
 * three chart components. Found at only 55% coverage: the bandwidth
 * debounce and all three overlay toggle buttons were never exercised.
 *
 * The debounce is the one piece of real, easy-to-silently-break logic
 * here (O(n^2) LOWESS recompute on every drag pixel without it) -- tested
 * with fake timers so the 150ms delay is verified deterministically, not
 * asserted after an arbitrary real sleep.
 *
 * Coverage
 * --------
 *   metric / standardize buttons call their handler with the right value
 *     and show the matching hint text
 *   smooth toggle passes the *inverse* of current state, not a fixed value
 *   bandwidth slider updates its displayed value immediately but only
 *     calls onSmoothBandwidth after the real 150ms debounce settles, and
 *     a second change within the window resets the timer rather than
 *     firing twice
 *   the slider's displayed value re-syncs if smoothBandwidth changes
 *     externally (parent reset)
 *   the whole Overlays group is opt-in: absent with no overlay handlers,
 *     and only the specific toggle whose handler was actually passed renders
 *   each overlay button passes the toggled boolean, not a fixed value
 *
 * Run: npx vitest run src/tests/chart-controls.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ChartControls, LOWESS_DEBOUNCE_MS } from '../components/charts/ChartControls'

function baseProps() {
  return {
    metric: 'egc' as const,
    onMetric: vi.fn(),
    standardize: false,
    onStandardize: vi.fn(),
    smoothed: false,
    onSmooth: vi.fn(),
    smoothBandwidth: 0.05,
    onSmoothBandwidth: vi.fn(),
  }
}

describe('ChartControls — metric and standardize', () => {
  it('clicking Relative Abundance calls onMetric with norm_egc', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<ChartControls {...props} />)
    await user.click(screen.getByRole('button', { name: 'Relative Abundance' }))
    expect(props.onMetric).toHaveBeenCalledWith('norm_egc')
  })

  it('shows the Relative Abundance hint only when that metric is active', () => {
    const { rerender } = render(<ChartControls {...baseProps()} />)
    expect(screen.queryByText('Relative Abundance (norm_egc)')).not.toBeInTheDocument()

    rerender(<ChartControls {...baseProps()} metric="norm_egc" />)
    expect(screen.getByText('Relative Abundance (norm_egc)')).toBeInTheDocument()
  })

  it('clicking Z-score calls onStandardize(true)', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<ChartControls {...props} />)
    await user.click(screen.getByRole('button', { name: 'Z-score' }))
    expect(props.onStandardize).toHaveBeenCalledWith(true)
  })

  it('clicking Off calls onStandardize(false) even when already off', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<ChartControls {...props} standardize />)
    // "Off" is ambiguous with the Smooth group's own Off label -- scoped by title instead.
    await user.click(screen.getByTitle('No standardization'))
    expect(props.onStandardize).toHaveBeenCalledWith(false)
  })
})

describe('ChartControls — smooth toggle', () => {
  it('smooth toggle button passes the inverse of the current smoothed state', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    const { rerender } = render(<ChartControls {...props} smoothed={false} />)
    await user.click(screen.getByTitle('LOWESS: locally weighted regression.'))
    expect(props.onSmooth).toHaveBeenCalledWith(true)

    props.onSmooth.mockClear()
    rerender(<ChartControls {...props} smoothed />)
    await user.click(screen.getByTitle('LOWESS: locally weighted regression.'))
    expect(props.onSmooth).toHaveBeenCalledWith(false)
  })

  it('shows the bandwidth slider only when smoothed is on', () => {
    const { rerender } = render(<ChartControls {...baseProps()} smoothed={false} />)
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()

    rerender(<ChartControls {...baseProps()} smoothed />)
    expect(screen.getByRole('slider')).toBeInTheDocument()
  })
})

describe('ChartControls — bandwidth slider debounce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('updates the displayed value immediately but delays onSmoothBandwidth by 150ms', () => {
    const props = baseProps()
    render(<ChartControls {...props} smoothed smoothBandwidth={0.05} />)

    // Dispatched directly (not via userEvent) so this fake-timers test isn't
    // also fighting userEvent's own internal timers.
    const slider = screen.getByRole('slider')
    Object.defineProperty(slider, 'value', { value: '0.03', configurable: true })
    slider.dispatchEvent(new Event('change', { bubbles: true }))

    // Displayed immediately, before the debounce fires.
    expect(screen.getByText('0.03')).toBeInTheDocument()
    expect(props.onSmoothBandwidth).not.toHaveBeenCalled()

    vi.advanceTimersByTime(LOWESS_DEBOUNCE_MS - 1)
    expect(props.onSmoothBandwidth).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(props.onSmoothBandwidth).toHaveBeenCalledWith(0.03)
    expect(props.onSmoothBandwidth).toHaveBeenCalledTimes(1)
  })

  it('a second change within the debounce window resets the timer instead of firing twice', () => {
    const props = baseProps()
    render(<ChartControls {...props} smoothed smoothBandwidth={0.05} />)
    const slider = screen.getByRole('slider')
    const half = Math.floor(LOWESS_DEBOUNCE_MS / 2)

    Object.defineProperty(slider, 'value', { value: '0.03', configurable: true })
    slider.dispatchEvent(new Event('change', { bubbles: true }))
    vi.advanceTimersByTime(half) // within the debounce window

    Object.defineProperty(slider, 'value', { value: '0.04', configurable: true })
    slider.dispatchEvent(new Event('change', { bubbles: true }))
    vi.advanceTimersByTime(half) // the first change's timer would have fired by now if not reset

    expect(props.onSmoothBandwidth).not.toHaveBeenCalled()

    vi.advanceTimersByTime(LOWESS_DEBOUNCE_MS - half) // completes the second change's own debounce
    expect(props.onSmoothBandwidth).toHaveBeenCalledTimes(1)
    expect(props.onSmoothBandwidth).toHaveBeenCalledWith(0.04)
  })

  it('re-syncs the displayed value when smoothBandwidth changes externally (parent reset)', () => {
    const props = baseProps()
    const { rerender } = render(<ChartControls {...props} smoothed smoothBandwidth={0.05} />)
    expect(screen.getByText('0.05')).toBeInTheDocument()

    rerender(<ChartControls {...props} smoothed smoothBandwidth={0.02} />)
    expect(screen.getByText('0.02')).toBeInTheDocument()
  })
})

describe('ChartControls — overlay group is opt-in', () => {
  it('renders no Overlays group when no overlay handlers are supplied', () => {
    render(<ChartControls {...baseProps()} />)
    expect(screen.queryByText('Overlays')).not.toBeInTheDocument()
  })

  it('renders only the Day/Night toggle when only that handler is supplied', () => {
    render(<ChartControls {...baseProps()} onShowNightShading={vi.fn()} showNightShading={false} />)
    expect(screen.getByText('Overlays')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Day\/Night/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Tide/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Day bands/ })).not.toBeInTheDocument()
  })

  it('clicking each overlay button passes the toggled (inverse) boolean', async () => {
    const user = userEvent.setup()
    const onShowNightShading = vi.fn()
    const onShowTide = vi.fn()
    const onShowDayBands = vi.fn()
    render(
      <ChartControls
        {...baseProps()}
        showNightShading={false} onShowNightShading={onShowNightShading}
        showTide onShowTide={onShowTide}
        showDayBands={false} onShowDayBands={onShowDayBands}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Day\/Night/ }))
    expect(onShowNightShading).toHaveBeenCalledWith(true)

    await user.click(screen.getByRole('button', { name: /Tide/ }))
    expect(onShowTide).toHaveBeenCalledWith(false) // was true -> toggles to false

    await user.click(screen.getByRole('button', { name: /Day bands/ }))
    expect(onShowDayBands).toHaveBeenCalledWith(true)
  })
})
