/**
 * chart-theme.unit.test.ts
 * =========================
 * Unit tests for the shared Plotly hover-tooltip style constant.
 *
 * Context
 * -------
 * EgcChart.tsx originally hardcoded a dark, readable `hoverlabel` style
 * inline in its own `layout` object. GroupedEgcChart, MultiEgcChart, and
 * the scaffold-modal Plotly charts never set `hoverlabel` at all, so they
 * fell back to Plotly's default light/black tooltip — hard to read against
 * this app's dark theme (most noticeable on the Taxonomy Explorer page,
 * which exclusively renders MultiEgcChart).
 *
 * `PLOTLY_HOVERLABEL` in utils/chartTheme.ts is the extracted single
 * source of truth all charts now import and spread into their `layout`.
 *
 * Run: npx vitest run src/tests/chart-theme.unit.test.ts
 */

import { describe, it, expect } from 'vitest'

import { PLOTLY_HOVERLABEL } from '../utils/chartTheme'

describe('PLOTLY_HOVERLABEL', () => {
  it('is a dark, translucent background (not Plotly default light)', () => {
    expect(PLOTLY_HOVERLABEL.bgcolor).toMatch(/^rgba\(\s*\d+,\s*\d+,\s*\d+,/)
    const match = PLOTLY_HOVERLABEL.bgcolor.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+)/)
    expect(match).not.toBeNull()
    const [, r, g, b] = match!.map(Number as unknown as (s: string) => number)
    // Dark background: each channel well below mid-gray.
    expect(r).toBeLessThan(60)
    expect(g).toBeLessThan(60)
    expect(b).toBeLessThan(60)
  })

  it('uses light, readable text color', () => {
    expect(PLOTLY_HOVERLABEL.font.color).toBe('#e8e8f0')
  })

  it('uses a monospace font to match the app chart aesthetic', () => {
    expect(PLOTLY_HOVERLABEL.font.family).toBe('monospace')
  })

  it('has a subtle border for separation from the plot background', () => {
    expect(PLOTLY_HOVERLABEL.bordercolor).toMatch(/^rgba\(/)
  })

  it('left-aligns multi-line hover text', () => {
    expect(PLOTLY_HOVERLABEL.align).toBe('left')
  })

  it('does not append trace name suffix (namelength: 0)', () => {
    expect(PLOTLY_HOVERLABEL.namelength).toBe(0)
  })
})
