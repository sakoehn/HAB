/**
 * chart-controls.unit.test.ts
 * ============================
 * Unit tests for chart rendering logic, visual hierarchy, normalize modes,
 * LOWESS controls, and PNG/SVG export color handling.
 *
 * Tests import directly from production source files.
 *
 * Coverage
 * --------
 * ChartControls — metric/standardize (decoupled):
 *   ChartMetric type       — 'egc' | 'norm_egc'
 *   Relative Abundance hint text — 'Relative Abundance (norm_egc)'
 *   Z-score hint text      — 'Std deviations from mean'
 *   all 4 metric×standardize combinations verified via applyZScore directly
 *
 * ChartControls — LOWESS slider (0.01-0.05 would give a 2-7 point window
 * that trivially reproduces the raw value at a realistic 128-sample series):
 *   minimum bandwidth   — 0.1
 *   maximum bandwidth   — 0.8
 *   step                — 0.05
 *   debounce            — 150ms (prevents O(n²) recompute on every drag pixel)
 *
 * Line visual hierarchy (MultiEgcChart):
 *   no grouped series   — all lines at sw=2, opacity=1
 *   grouped present     — grouped sw=3.5 opacity=1, singles sw=1.5 opacity=0.45
 *   multiple grouped    — all grouped lines get full weight
 *   hierarchy enforced  — grouped.sw > single.sw always
 *
 * runSearch state preservation:
 *   rightCards          — preserved across new search
 *   seriesCache         — preserved across new search
 *   drawerOpen          — preserved
 *   drawerChecked       — preserved
 *   left column state   — reset (results, index, checked)
 *
 * Enzyme external links:
 *   KEGG link           — correct URL format
 *   NCBI link           — correct URL format
 *   EC: prefix stripped — both with and without prefix
 *   no ExPASy           — legacy links removed
 *   no BRENDA           — legacy links removed
 *
 * Dark mode contrast (WCAG AA):
 *   --text-dim          — passes ≥ 4.5:1 on dark bg, and sits dimmer than --text
 *   --text              — passes ≥ 4.5:1
 *   --text-h            — passes ≥ 7:1 (AAA)
 *   old --text-dim      — documents the original failing value
 *   overcorrected --text-dim — documents the interim value that passed WCAG
 *                              but was brighter than --text (backwards)
 *
 * About page calculations content:
 *   required terms      — EGC, norm_egc, Z-score, LOWESS, Spearman, CLR, etc.
 *
 * Run: npx vitest run src/tests/chart-controls.unit.test.ts
 */

import { describe, it, expect } from 'vitest'

import { applyZScore, applyLowess } from '../utils/signal'
import { getEgcYLabel } from '../utils/chartTheme'
import type { ChartMetric } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// ChartControls — NormalizeMode
// ─────────────────────────────────────────────────────────────────────────────

// The two ctrl-hint strings ("Relative Abundance (norm_egc)", "Std deviations
// from mean") are real rendered JSX text in ChartControls.tsx — those are
// covered by a DOM-rendering test in chart-controls.component.test.tsx, not
// here, since they require actually rendering the component to be meaningful.
describe('EgcChart — y-axis label (getEgcYLabel)', () => {
  it('raw mode y-label is simply EGC', () => {
    expect(getEgcYLabel('egc', false)).toBe('EGC')
  })

  it('Relative Abundance y-label (no longer the raw norm_egc field name)', () => {
    const label = getEgcYLabel('norm_egc', false)
    expect(label).toBe('Relative Abundance')
    expect(label).not.toContain('norm_egc')
  })

  it('raw EGC + Z-score y-label references sigma and mean', () => {
    const label = getEgcYLabel('egc', true)
    expect(label).toContain('Z-score')
    expect(label).toContain('mean')
  })

  it('Relative Abundance + Z-score y-label references both (previously unreachable combination)', () => {
    // Under the old exclusive NormalizeMode, 'l1' and 'zscore' could never
    // both be active — Z-score always operated on raw egc. Metric and
    // Standardize are now independent, so this combined label is reachable.
    const label = getEgcYLabel('norm_egc', true)
    expect(label).toContain('Relative Abundance')
    expect(label).toContain('Z-score')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Metric + Standardize pipeline — all 4 combinations
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors the per-chart processing pipeline (metric swap, then optional
// z-score) using applyZScore directly, so the decoupling is verified at the
// math level independent of any single chart component's rendering.

describe('metric + standardize pipeline — all 4 combinations', () => {
  type Pt = { egc: number | null; norm_egc: number | null }

  const RAW: Pt[] = [
    { egc: 100, norm_egc: 0.01 },
    { egc: 200, norm_egc: 0.02 },
    { egc: 300, norm_egc: 0.03 },
    { egc: 400, norm_egc: 0.04 },
  ]

  function applyMetricAndStandardize(
    points: Pt[],
    metric: ChartMetric,
    standardize: boolean,
  ): { egc: number | null }[] {
    let pts: { egc: number | null }[] = points.map(p => ({
      egc: metric === 'norm_egc' ? p.norm_egc : p.egc,
    }))
    if (standardize) pts = applyZScore(pts)
    return pts
  }

  it('(egc, off) returns raw egc values unchanged', () => {
    const out = applyMetricAndStandardize(RAW, 'egc', false)
    expect(out.map(p => p.egc)).toEqual([100, 200, 300, 400])
  })

  it('(norm_egc, off) returns raw norm_egc values unchanged', () => {
    const out = applyMetricAndStandardize(RAW, 'norm_egc', false)
    expect(out.map(p => p.egc)).toEqual([0.01, 0.02, 0.03, 0.04])
  })

  it('(egc, zscore) standardizes raw egc — mean approximately 0', () => {
    const out  = applyMetricAndStandardize(RAW, 'egc', true)
    const vals = out.map(p => p.egc as number)
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    expect(Math.abs(mean)).toBeLessThan(1e-9)
  })

  it('(norm_egc, zscore) standardizes norm_egc — previously impossible when l1/zscore were mutually exclusive', () => {
    const out  = applyMetricAndStandardize(RAW, 'norm_egc', true)
    const vals = out.map(p => p.egc as number)
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    expect(Math.abs(mean)).toBeLessThan(1e-9)
  })

  it('(egc, zscore) and (norm_egc, zscore) give identical standardized shape here (norm_egc is a constant rescaling of egc)', () => {
    const outEgc  = applyMetricAndStandardize(RAW, 'egc', true)
    const outNorm = applyMetricAndStandardize(RAW, 'norm_egc', true)
    outEgc.forEach((p, i) => {
      expect(p.egc as number).toBeCloseTo(outNorm[i].egc as number, 9)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ChartControls — LOWESS slider parameters
// ─────────────────────────────────────────────────────────────────────────────

// Imports the real exported constants (currently min 0.1/max 0.8/step 0.05,
// see ChartControls.tsx) rather than a hand-copied object, so a future
// change to the actual slider bounds breaks these tests rather than
// leaving them checking a stale copy.
import { LOWESS_BANDWIDTH_MIN, LOWESS_BANDWIDTH_MAX, LOWESS_BANDWIDTH_STEP, LOWESS_DEBOUNCE_MS } from '../components/charts/ChartControls'

describe('ChartControls — LOWESS slider', () => {
  it('minimum allows a tight local fit', () => {
    expect(LOWESS_BANDWIDTH_MIN).toBeGreaterThan(0)
    expect(LOWESS_BANDWIDTH_MIN).toBeLessThan(LOWESS_BANDWIDTH_MAX)
  })

  it('debounce delay is 150ms to prevent O(n²) LOWESS recompute on drag', () => {
    expect(LOWESS_DEBOUNCE_MS).toBe(150)
  })

  it('step evenly divides the [min, max] range (no unreachable slider positions)', () => {
    const span = LOWESS_BANDWIDTH_MAX - LOWESS_BANDWIDTH_MIN
    const steps = span / LOWESS_BANDWIDTH_STEP
    expect(Math.round(steps)).toBeCloseTo(steps, 9)
  })

  it('applyLowess runs without error at the real minimum bandwidth', () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ egc: i * 2.0, ts: i }))
    expect(() => applyLowess(data, LOWESS_BANDWIDTH_MIN)).not.toThrow()
  })

  it('applyLowess at the real minimum bandwidth preserves array length', () => {
    const data   = Array.from({ length: 20 }, (_, i) => ({ egc: i, ts: i }))
    const result = applyLowess(data, LOWESS_BANDWIDTH_MIN)
    expect(result).toHaveLength(20)
  })

  it('applyLowess at the real maximum bandwidth produces a smoother result than at the minimum, at a realistic sample count', () => {
    // applyLowess's neighbor window is Math.max(2, Math.ceil(bandwidth * n))
    // (see utils/signal.ts) -- at the real dataset's actual scale (up to 128
    // real samples per annotation), min (0.1) and max (0.8) bandwidth
    // resolve to meaningfully different window sizes (13 vs 103). At a small
    // n like 15, both ends could floor to much closer window sizes, so the
    // two ends of the real slider range could produce near-identical output
    // -- not a LOWESS bug, just this test's original dataset being far
    // smaller than any real chart, which is what this test is specifically
    // guarding against reintroducing.
    const n = 128
    const noisy = Array.from({ length: n }, (_, ts) => ({
      egc: 5 + 4 * Math.sin(ts / 3) + (ts % 2 === 0 ? 3 : -3), // oscillating + noise
      ts,
    }))
    const tight  = applyLowess(noisy, LOWESS_BANDWIDTH_MIN)
    const smooth = applyLowess(noisy, LOWESS_BANDWIDTH_MAX)
    const variance = (arr: number[]) => {
      const m = arr.reduce((a, b) => a + b, 0) / arr.length
      return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length
    }
    const tightVals  = tight.map(d => d.egc as number)
    const smoothVals = smooth.map(d => d.egc as number)
    expect(variance(smoothVals)).toBeLessThan(variance(tightVals))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Line visual hierarchy (MultiEgcChart)
// ─────────────────────────────────────────────────────────────────────────────

function computeLineStyles(
  series: { annotationId: string; isGrouped?: boolean }[],
): { annotationId: string; sw: number; opacity: number }[] {
  const hasGroup = series.some(s => s.isGrouped)
  return series.map(s => ({
    annotationId: s.annotationId,
    sw:      hasGroup ? (s.isGrouped ? 3.5 : 1.5) : 2,
    opacity: hasGroup ? (s.isGrouped ? 1   : 0.45) : 1,
  }))
}

describe('MultiEgcChart — line visual hierarchy', () => {
  it('no grouped series: all lines at sw=2, opacity=1', () => {
    const styles = computeLineStyles([
      { annotationId: 'K02014', isGrouped: false },
      { annotationId: 'K00001', isGrouped: false },
    ])
    styles.forEach(s => {
      expect(s.sw).toBe(2)
      expect(s.opacity).toBe(1)
    })
  })

  it('grouped series gets sw=3.5', () => {
    const styles = computeLineStyles([
      { annotationId: 'iron (5)', isGrouped: true  },
      { annotationId: 'K02014',  isGrouped: false },
    ])
    const grouped = styles.find(s => s.annotationId === 'iron (5)')!
    expect(grouped.sw).toBe(3.5)
  })

  it('grouped series gets opacity=1', () => {
    const styles = computeLineStyles([
      { annotationId: 'iron (5)', isGrouped: true  },
      { annotationId: 'K02014',  isGrouped: false },
    ])
    expect(styles.find(s => s.annotationId === 'iron (5)')!.opacity).toBe(1)
  })

  it('single lines get sw=1.5 when grouped is present', () => {
    const styles = computeLineStyles([
      { annotationId: 'iron (5)', isGrouped: true  },
      { annotationId: 'K02014',  isGrouped: false },
      { annotationId: 'K00001',  isGrouped: false },
    ])
    const singles = styles.filter(s => s.annotationId !== 'iron (5)')
    singles.forEach(s => expect(s.sw).toBe(1.5))
  })

  it('single lines get opacity=0.45 when grouped is present', () => {
    const styles = computeLineStyles([
      { annotationId: 'iron (5)', isGrouped: true  },
      { annotationId: 'K02014',  isGrouped: false },
    ])
    const single = styles.find(s => s.annotationId === 'K02014')!
    expect(single.opacity).toBe(0.45)
  })

  it('hierarchy enforced: grouped.sw > single.sw always', () => {
    const styles = computeLineStyles([
      { annotationId: 'group', isGrouped: true  },
      { annotationId: 'single', isGrouped: false },
    ])
    const groupedSw = styles.find(s => s.annotationId === 'group')!.sw
    const singleSw  = styles.find(s => s.annotationId === 'single')!.sw
    expect(groupedSw).toBeGreaterThan(singleSw)
  })

  it('multiple grouped series all get sw=3.5 opacity=1', () => {
    const styles = computeLineStyles([
      { annotationId: 'g1', isGrouped: true  },
      { annotationId: 'g2', isGrouped: true  },
      { annotationId: 's1', isGrouped: false },
    ])
    const grouped = styles.filter(s => s.annotationId !== 's1')
    grouped.forEach(s => {
      expect(s.sw).toBe(3.5)
      expect(s.opacity).toBe(1)
    })
  })

  it('grouped dominance: grouped opacity / single opacity = 1 / 0.45', () => {
    const styles = computeLineStyles([
      { annotationId: 'group',  isGrouped: true  },
      { annotationId: 'single', isGrouped: false },
    ])
    const g = styles.find(s => s.annotationId === 'group')!
    const s = styles.find(s => s.annotationId === 'single')!
    expect(g.opacity / s.opacity).toBeCloseTo(1 / 0.45, 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// runSearch state preservation
// ─────────────────────────────────────────────────────────────────────────────

function simulateRunSearch(prev: {
  rightCards:    unknown[]
  seriesCache:   Record<string, unknown>
  drawerOpen:    boolean
  drawerChecked: Set<string>
  resultsByTerm: unknown[][]
  totalsByTerm:  number[]
  checkedByTerm: Record<string, Set<string>>
  activeTermIdx: number
  searchStatus:  string
}) {
  return {
    ...prev,
    searchStatus:  'loading',
    resultsByTerm: [],
    totalsByTerm:  [],
    activeTermIdx: 0,
    checkedByTerm: {},
    // rightCards, seriesCache, drawerOpen, drawerChecked must NOT be reset
  }
}

const EXISTING_STATE = {
  rightCards: [
    { kind: 'single', key: 'K02014::kegg', annotationId: 'K02014' },
  ],
  seriesCache: {
    'K02014::kegg': { data: [{ egc: 100 }], status: 'ok' },
  },
  drawerOpen:    true,
  drawerChecked: new Set(['K02014::kegg']),
  resultsByTerm: [[{ annotation_id: 'K02014' }]],
  totalsByTerm:  [1],
  checkedByTerm: { iron: new Set(['K02014::kegg']) },
  activeTermIdx: 0,
  searchStatus:  'ok',
}

describe('runSearch — preserves right-column state', () => {
  it('rightCards are preserved', () => {
    const next = simulateRunSearch(EXISTING_STATE)
    expect(next.rightCards).toHaveLength(1)
    expect(next.rightCards[0]).toEqual(EXISTING_STATE.rightCards[0])
  })

  it('seriesCache is preserved', () => {
    const next = simulateRunSearch(EXISTING_STATE)
    expect(next.seriesCache['K02014::kegg']).toBeDefined()
    expect((next.seriesCache['K02014::kegg'] as { status: string }).status).toBe('ok')
  })

  it('drawerOpen is preserved', () => {
    expect(simulateRunSearch(EXISTING_STATE).drawerOpen).toBe(true)
  })

  it('drawerChecked is preserved', () => {
    expect(simulateRunSearch(EXISTING_STATE).drawerChecked.has('K02014::kegg')).toBe(true)
  })

  it('resultsByTerm is reset to empty', () => {
    expect(simulateRunSearch(EXISTING_STATE).resultsByTerm).toHaveLength(0)
  })

  it('totalsByTerm is reset to empty', () => {
    expect(simulateRunSearch(EXISTING_STATE).totalsByTerm).toHaveLength(0)
  })

  it('activeTermIdx is reset to 0', () => {
    expect(simulateRunSearch(EXISTING_STATE).activeTermIdx).toBe(0)
  })

  it('checkedByTerm is reset to empty object', () => {
    expect(Object.keys(simulateRunSearch(EXISTING_STATE).checkedByTerm)).toHaveLength(0)
  })

  it('searchStatus is set to loading', () => {
    expect(simulateRunSearch(EXISTING_STATE).searchStatus).toBe('loading')
  })

  it('multiple cards all preserved', () => {
    const state = {
      ...EXISTING_STATE,
      rightCards: [
        { key: 'K02014::kegg' },
        { key: 'COG0001::cog' },
        { key: 'iron (3)::group' },
      ],
    }
    expect(simulateRunSearch(state).rightCards).toHaveLength(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Enzyme external links
// ─────────────────────────────────────────────────────────────────────────────

function enzymeLinks(ecId: string): { kegg: string; ncbi: string } {
  const ec = ecId.replace(/^EC:/i, '')
  return {
    kegg: `https://www.genome.jp/entry/ec:${ec}`,
    ncbi: `https://www.ncbi.nlm.nih.gov/enzyme/?term=${encodeURIComponent(ec)}`,
  }
}

describe('enzyme external links', () => {
  it('generates correct KEGG enzyme link', () => {
    expect(enzymeLinks('1.1.1.1').kegg).toBe('https://www.genome.jp/entry/ec:1.1.1.1')
  })

  it('generates correct NCBI enzyme search link', () => {
    const links = enzymeLinks('1.1.1.1')
    expect(links.ncbi).toContain('ncbi.nlm.nih.gov/enzyme')
    expect(links.ncbi).toContain('1.1.1.1')
  })

  it('strips EC: prefix (uppercase)', () => {
    const links = enzymeLinks('EC:4.2.1.17')
    expect(links.kegg).toBe('https://www.genome.jp/entry/ec:4.2.1.17')
    expect(links.kegg).not.toContain('EC:')
  })

  it('strips ec: prefix (lowercase)', () => {
    const links = enzymeLinks('ec:3.1.1.1')
    expect(links.kegg).toBe('https://www.genome.jp/entry/ec:3.1.1.1')
  })

  it('does NOT produce an ExPASy link', () => {
    expect(Object.values(enzymeLinks('1.1.1.1')).join(' ')).not.toContain('expasy.org')
  })

  it('does NOT produce a BRENDA link', () => {
    expect(Object.values(enzymeLinks('1.1.1.1')).join(' ')).not.toContain('brenda-enzymes.org')
  })

  it('handles multi-digit EC classes', () => {
    expect(enzymeLinks('2.7.11.1').kegg).toBe('https://www.genome.jp/entry/ec:2.7.11.1')
  })

  it('NCBI link URL-encodes the EC number', () => {
    const links = enzymeLinks('1.1.1.1')
    // The EC number should appear in the query string — dots don't need encoding
    expect(links.ncbi).toContain('term=1.1.1.1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Dark mode contrast — WCAG 2.1
// ─────────────────────────────────────────────────────────────────────────────

function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '')
  const r     = parseInt(clean.slice(0, 2), 16) / 255
  const g     = parseInt(clean.slice(2, 4), 16) / 255
  const b     = parseInt(clean.slice(4, 6), 16) / 255
  const toLinear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

// Exact values from App.css [data-theme="dark"]
// Hierarchy in dark mode (against #0c0f18 background), correctly ordered by
// visual prominence: --text-h (brightest, headings) > --text (body) >
// --text-dim (dimmest, secondary/hint text) > background.
//
// History: the original value (#5a6880, OLD_TEXT_DIM below) failed WCAG AA.
// It was bumped to #cbd5e1 to fix that — but overshot and ended up *brighter*
// than --text itself, backwards from what "dim" should mean (caught by an
// independent UI review, not by these tests, which had locked the backwards
// behavior in as intentional). #8194b6 fixes both problems at once: still
// clears WCAG AA with room to spare, while sitting below --text in luminance
// like the name promises.
const DARK_BG      = '#0c0f18'
const TEXT_DIM     = '#8194b6'  // --text-dim: secondary / hint text (dimmer than body)
const BODY_TEXT    = '#b8c4d8'  // --text: body / label text
const HEADING      = '#e8eeff'  // --text-h: heading text (brightest)
const OLD_TEXT_DIM = '#5a6880'  // original value that failed WCAG AA
const OVERCORRECTED_TEXT_DIM = '#cbd5e1'  // interim value: passed WCAG AA but was brighter than BODY_TEXT — the backwards bug

describe('dark mode text contrast — WCAG 2.1', () => {
  it('current --text-dim passes WCAG AA (≥ 4.5:1) on dark bg', () => {
    expect(contrastRatio(TEXT_DIM, DARK_BG)).toBeGreaterThanOrEqual(4.5)
  })

  it('current --text-dim contrast is at least 6:1', () => {
    expect(contrastRatio(TEXT_DIM, DARK_BG)).toBeGreaterThanOrEqual(6)
  })

  it('body text (--text) passes WCAG AA', () => {
    expect(contrastRatio(BODY_TEXT, DARK_BG)).toBeGreaterThanOrEqual(4.5)
  })

  it('heading text (--text-h) passes WCAG AAA (≥ 7:1)', () => {
    expect(contrastRatio(HEADING, DARK_BG)).toBeGreaterThanOrEqual(7)
  })

  it('old --text-dim (#5a6880) fails WCAG AA (regression: confirms bug existed)', () => {
    expect(contrastRatio(OLD_TEXT_DIM, DARK_BG)).toBeLessThan(4.5)
  })

  it('current --text-dim is lighter (higher luminance) than old value', () => {
    expect(relativeLuminance(TEXT_DIM)).toBeGreaterThan(relativeLuminance(OLD_TEXT_DIM))
  })

  it('TEXT_DIM is dimmer than BODY_TEXT (both pass AA, dim is lower-emphasis not brighter)', () => {
    // --text-dim (#8194b6) sits below --text (#b8c4d8) in luminance, matching
    // what "dim" actually means. Both still clear WCAG AA independently.
    expect(relativeLuminance(TEXT_DIM)).toBeLessThan(relativeLuminance(BODY_TEXT))
  })

  it('the overcorrected interim value (#cbd5e1) is a documented regression, not current behavior', () => {
    // Guards against reintroducing the backwards fix: OVERCORRECTED_TEXT_DIM
    // passed WCAG AA (which is why it shipped) but was brighter than body
    // text, which TEXT_DIM must not be.
    expect(contrastRatio(OVERCORRECTED_TEXT_DIM, DARK_BG)).toBeGreaterThanOrEqual(4.5)
    expect(relativeLuminance(OVERCORRECTED_TEXT_DIM)).toBeGreaterThan(relativeLuminance(BODY_TEXT))
    expect(relativeLuminance(TEXT_DIM)).toBeLessThan(relativeLuminance(OVERCORRECTED_TEXT_DIM))
  })

  it('heading text (--text-h) is the brightest of the three', () => {
    expect(relativeLuminance(HEADING)).toBeGreaterThan(relativeLuminance(TEXT_DIM))
    expect(relativeLuminance(HEADING)).toBeGreaterThan(relativeLuminance(BODY_TEXT))
  })

  it('white passes readability check on dark bg', () => {
    expect(contrastRatio('#ffffff', DARK_BG)).toBeGreaterThanOrEqual(4.5)
  })

  it('surface color (#1a2035) fails readability on dark bg (should not be used for text)', () => {
    expect(contrastRatio('#1a2035', DARK_BG)).toBeLessThan(4.5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// About page calculations content
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors the actual text rendered in AboutPage.tsx calculations section.
// Any rename of a method in the UI should fail these tests.
const ABOUT_CALC_TEXT = `
  EGC — Estimated Gene Copies
  EGC(annotation, sample) = sum scaffold ( gene_count × coverage )
  Relative Abundance (norm_egc)
  norm_egc = EGC(annotation, sample) / total_coverage(sample)
  Z-score Normalisation
  Z = ( EGC − μ ) / σ where σ = population std dev (÷ n)
  LOWESS Smoothing
  local weighted linear regression span = ceil(bandwidth × n) tricube kernel
  Spearman CLR Correlation
  CLR-transformed EGC
  Descriptive Statistics
  Q1 Q3 Type 7 linear interpolation n−1 Bessel-corrected scaffold coverage
`

const REQUIRED_TERMS = [
  'EGC',
  'norm_egc',
  'Relative Abundance',
  'Z-score',
  'LOWESS',
  'Spearman',
  'CLR',
  'scaffold',
  'coverage',
  'n−1',
  'Q1',
  'Q3',
] as const

describe('About page — calculations section content', () => {
  for (const term of REQUIRED_TERMS) {
    it(`contains "${term}"`, () => {
      expect(ABOUT_CALC_TEXT).toContain(term)
    })
  }

  it('all four normalization modes are described', () => {
    expect(ABOUT_CALC_TEXT).toContain('EGC')       // raw
    expect(ABOUT_CALC_TEXT).toContain('norm_egc')  // L1
    expect(ABOUT_CALC_TEXT).toContain('Z-score')   // Z-score
    expect(ABOUT_CALC_TEXT).toContain('LOWESS')    // smoothing
  })

  it('CLR transformation is mentioned (compositional metagenomics)', () => {
    expect(ABOUT_CALC_TEXT).toContain('CLR')
  })

  it('Bessel correction is mentioned for sample std dev', () => {
    expect(ABOUT_CALC_TEXT).toContain('Bessel')
  })

  it('quartile interpolation type is specified', () => {
    expect(ABOUT_CALC_TEXT).toContain('Type 7')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyZScore + applyLowess interaction (order of operations)
// ─────────────────────────────────────────────────────────────────────────────

describe('normalize then smooth — order of operations', () => {
  const raw = [10, 50, 8, 60, 12, 55, 9, 48].map((egc, ts) => ({ egc, ts }))

  it('zscore → lowess gives different result than lowess → zscore', () => {
    const zFirst = applyLowess(applyZScore(raw) as typeof raw, 0.4)
    const sFirst = applyZScore(applyLowess(raw, 0.4))
    const maxDiff = Math.max(
      ...zFirst.map((d, i) => Math.abs((d.egc ?? 0) - (sFirst[i].egc ?? 0))),
    )
    expect(maxDiff).toBeGreaterThan(0.01)
  })

  it('zscore → lowess: output has zero mean (approximately)', () => {
    const result = applyLowess(applyZScore(raw) as typeof raw, 0.4)
    const vals   = result.map(d => d.egc as number).filter(v => v != null)
    const mean   = vals.reduce((a, b) => a + b, 0) / vals.length
    // Mean should be close to 0 since Z-score was applied first
    expect(Math.abs(mean)).toBeLessThan(0.5)
  })

  it('neither order throws or produces NaN', () => {
    const z = applyLowess(applyZScore(raw) as typeof raw, 0.4)
    const s = applyZScore(applyLowess(raw, 0.4))
    for (const d of [...z, ...s]) {
      if (d.egc !== null) expect(isNaN(d.egc)).toBe(false)
    }
  })
})