/**
 * chart-controls.component.test.tsx
 * ===================================
 * Component (DOM-rendering) tests for ChartControls.
 *
 * The metric/standardize ctrl-hint strings used to be pinned down as
 * self-referential string literals in chart-controls.unit.test.ts (asserting
 * a local constant contains a substring of itself, never reading anything
 * from ChartControls.tsx). These render the real component instead, so a
 * change to the actual hint text or its conditional visibility is caught.
 *
 * Coverage
 * --------
 *   "Relative Abundance (norm_egc)" hint shown only when metric === 'norm_egc'
 *   "Std deviations from mean" hint shown only when standardize === true
 *   clicking "Relative Abundance" calls onMetric('norm_egc')
 *   clicking "Z-score" calls onStandardize(true)
 *   bandwidth hint only rendered when smoothed === true
 *
 * Run: npx vitest run src/tests/chart-controls.component.test.tsx
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ChartControls } from '../components/charts/ChartControls'
import type { ChartMetric } from '../types'

function renderControls(overrides: Partial<{
  metric:          ChartMetric
  standardize:     boolean
  smoothed:        boolean
  smoothBandwidth: number
}> = {}) {
  const onMetric            = vi.fn()
  const onStandardize       = vi.fn()
  const onSmooth            = vi.fn()
  const onSmoothBandwidth   = vi.fn()

  render(
    <ChartControls
      metric={overrides.metric ?? 'egc'}
      onMetric={onMetric}
      standardize={overrides.standardize ?? false}
      onStandardize={onStandardize}
      smoothed={overrides.smoothed ?? false}
      onSmooth={onSmooth}
      smoothBandwidth={overrides.smoothBandwidth ?? 0.03}
      onSmoothBandwidth={onSmoothBandwidth}
    />,
  )

  return { onMetric, onStandardize, onSmooth, onSmoothBandwidth }
}

describe('ChartControls — metric hint', () => {
  it('shows the Relative Abundance hint when metric is norm_egc', () => {
    renderControls({ metric: 'norm_egc' })
    expect(screen.getByText('Relative Abundance (norm_egc)')).toBeInTheDocument()
  })

  it('does not show the Relative Abundance hint for raw egc', () => {
    renderControls({ metric: 'egc' })
    expect(screen.queryByText('Relative Abundance (norm_egc)')).not.toBeInTheDocument()
  })

  it('clicking the Relative Abundance pill calls onMetric with norm_egc', async () => {
    const user = userEvent.setup()
    const { onMetric } = renderControls({ metric: 'egc' })
    await user.click(screen.getByText('Relative Abundance'))
    expect(onMetric).toHaveBeenCalledWith('norm_egc')
  })
})

describe('ChartControls — standardize hint', () => {
  it('shows the "Std deviations from mean" hint when standardize is on', () => {
    renderControls({ standardize: true })
    expect(screen.getByText('Std deviations from mean')).toBeInTheDocument()
  })

  it('does not show the standardize hint when off', () => {
    renderControls({ standardize: false })
    expect(screen.queryByText('Std deviations from mean')).not.toBeInTheDocument()
  })

  it('clicking Z-score calls onStandardize with true', async () => {
    const user = userEvent.setup()
    const { onStandardize } = renderControls({ standardize: false })
    await user.click(screen.getByText('Z-score'))
    expect(onStandardize).toHaveBeenCalledWith(true)
  })
})

describe('ChartControls — smooth bandwidth slider', () => {
  it('does not render the bandwidth slider when smoothed is off', () => {
    renderControls({ smoothed: false })
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('renders the bandwidth slider and value hint when smoothed is on', () => {
    renderControls({ smoothed: true, smoothBandwidth: 0.03 })
    expect(screen.getByRole('slider')).toBeInTheDocument()
    expect(screen.getByText('0.03')).toBeInTheDocument()
  })
})
