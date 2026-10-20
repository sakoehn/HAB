/**
 * stats-panel.component.test.tsx
 * =================================
 * Component tests for StatsPanel (components/ui/StatsPanel.tsx) -- zero
 * prior direct coverage (only exercised indirectly through chart tests).
 *
 * Two related behaviors:
 *   (a) A `series` prop (one row per annotation), as an alternative to the
 *       single-set `vals` -- pooling every series' values into one flat
 *       array would give e.g. a 4.8e-4 series and a 7.8e-6 series one
 *       meaningless blended mean/CV describing neither.
 *   (b) CV = std/mean blows up once the mean is negligible relative to the
 *       spread -- pooling two Z-scored series (mean forced to ~0 by
 *       construction) gives CV "-57308638803537928192.0%". Handled with a
 *       `standardize` flag (always suppress CV) plus a general
 *       relative-magnitude guard (suppress CV whenever |mean| is negligible
 *       next to |std|, regardless of whether standardize is set).
 *
 * Coverage
 * --------
 *   single-vals mode: unchanged behavior, real CV shown
 *   standardize=true: CV always shows "—", even with a real non-zero mean
 *   near-zero mean (not via standardize): CV shows "—" via the relative-
 *     magnitude guard, not just an exact-zero check
 *   a genuinely small-but-real mean does NOT get suppressed (guard isn't
 *     over-eager)
 *   series mode: one row per series, correct label per row, independent
 *     stats (not pooled)
 *   empty vals / no matching series -> renders nothing
 *
 * Run: npx vitest run src/tests/stats-panel.component.test.tsx
 */

import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { StatsPanel } from '../components/ui/StatsPanel'

function cellValue(container: HTMLElement, label: string): string {
  const labelEl = within(container).getAllByText(label)
    .find(el => el.className === 'stat-cell-label')!
  return labelEl.closest('.stat-cell')!.querySelector('.stat-cell-value')!.textContent!
}

describe('StatsPanel — single vals mode', () => {
  it('shows a real CV percentage for an ordinary (non-standardized) distribution', () => {
    const { container } = render(<StatsPanel vals={[10, 20, 30, 40, 50]} yLabel="EGC" />)
    expect(cellValue(container, 'n')).toBe('5')
    expect(cellValue(container, 'CV')).not.toBe('—')
    expect(cellValue(container, 'CV')).toMatch(/%$/)
  })

  it('renders nothing for an empty vals array', () => {
    const { container } = render(<StatsPanel vals={[]} yLabel="EGC" />)
    expect(container.firstChild).toBeNull()
  })
})

describe('StatsPanel — CV suppression', () => {
  it('CV shows "—" when standardize is true, even with a real non-zero mean', () => {
    // Values with a real, non-negligible mean -- if the standardize flag
    // weren't checked directly, this CV would compute to a real (if
    // possibly odd) number instead of being suppressed.
    const { container } = render(
      <StatsPanel vals={[10, 20, 30, 40, 50]} yLabel="EGC" standardize />,
    )
    expect(cellValue(container, 'CV')).toBe('—')
  })

  it('CV shows "—" for a near-zero mean even without the standardize flag (organic Z-score residual)', () => {
    // The actual output of Z-scoring a real 10-value dataset ((x-mean)/std,
    // computed independently in Node) -- std is exactly 1 by construction,
    // mean is a genuine floating-point residual (-1.998e-16), not exactly
    // 0. This is the real mechanism behind a CV like
    // "-57308638803537928192.0%": mean isn't 0, it's just 16 orders of
    // magnitude smaller than std, which is exactly what the relative-
    // magnitude guard (not an exact `mean !== 0` check) needs to catch.
    const zScoredValues = [
      -0.8247372746671177, 0.34244297379930877, -0.9824643352706888,
      1.9021883508790676, -0.4356771918449756, 0.7315030566214509,
      -0.9439088315675938, -0.04661710902283343, 1.1205631394435929,
      -0.8632927783702129,
    ]
    const { container } = render(<StatsPanel vals={zScoredValues} yLabel="Z-score" />)
    expect(cellValue(container, 'CV')).toBe('—')
  })

  it('does NOT suppress CV for a genuinely small-but-real mean (guard is relative, not absolute)', () => {
    // mean and std are both small in absolute terms, but proportionally
    // consistent -- a real, meaningful CV, not a near-zero-denominator
    // artifact. Must not be caught by the same guard.
    const { container } = render(
      <StatsPanel vals={[9e-7, 1e-6, 1.1e-6, 1e-6, 1e-6]} yLabel="norm_egc" />,
    )
    expect(cellValue(container, 'CV')).not.toBe('—')
  })

  it('a flat (zero-variance) series shows 0.0% CV, not "—" and not NaN', () => {
    const { container } = render(<StatsPanel vals={[5, 5, 5, 5]} yLabel="EGC" />)
    expect(cellValue(container, 'CV')).toBe('0.0%')
  })
})

describe('StatsPanel — series mode', () => {
  it('renders one row per series with independent, un-pooled stats', () => {
    render(
      <StatsPanel
        series={[
          { label: 'COG0055', vals: [4.6e-4, 4.8e-4, 5.0e-4] },
          { label: 'K02568',  vals: [7.6e-6, 7.8e-6, 8.0e-6] },
        ]}
        yLabel="Relative Abundance"
      />,
    )
    const blocks = screen.getAllByText(/COG0055|K02568/, { selector: '.stats-panel-series-label' })
    expect(blocks).toHaveLength(2)

    const cog = blocks.find(b => b.textContent === 'COG0055')!.closest('.stats-panel-series')!
    const k02 = blocks.find(b => b.textContent === 'K02568')!.closest('.stats-panel-series')!

    // Each series' own mean -- if pooled together, both
    // would instead show one blended mean around 2.4e-4 describing neither.
    expect(cellValue(cog, 'Mean')).toMatch(/^4\.8/)
    expect(cellValue(k02, 'Mean')).toMatch(/^7\.8/)
  })

  it('passes standardize through to every row', () => {
    render(
      <StatsPanel
        series={[
          { label: 'A', vals: [1, 2, 3] },
          { label: 'B', vals: [4, 5, 6] },
        ]}
        yLabel="Z-score"
        standardize
      />,
    )
    for (const cv of screen.getAllByText('CV', { selector: '.stat-cell-label' })) {
      expect(cv.closest('.stat-cell')!.querySelector('.stat-cell-value')!.textContent).toBe('—')
    }
  })

  it('renders nothing when every series in the list is empty', () => {
    const { container } = render(
      <StatsPanel series={[{ label: 'A', vals: [] }]} yLabel="EGC" />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('skips only the empty series, keeps the ones with real data', () => {
    render(
      <StatsPanel
        series={[
          { label: 'Empty', vals: [] },
          { label: 'Real',  vals: [1, 2, 3] },
        ]}
        yLabel="EGC"
      />,
    )
    expect(screen.queryByText('Empty', { selector: '.stats-panel-series-label' })).not.toBeInTheDocument()
    expect(screen.getByText('Real', { selector: '.stats-panel-series-label' })).toBeInTheDocument()
  })
})
