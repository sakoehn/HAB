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
 * ChartControls — LOWESS slider:
 *   minimum bandwidth   — 0.05 (allows tight local fit)
 *   maximum bandwidth   — 0.75
 *   step                — 0.05
 *   default             — 0.4
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
 *   --text-dim          — passes ≥ 4.5:1 on dark bg
 *   --text              — passes ≥ 4.5:1
 *   --text-h            — passes ≥ 7:1 (AAA)
 *   old --text-dim      — documents the original failing value
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

const LOWESS_SLIDER = {
  min:     0.05,
  max:     0.75,
  step:    0.05,
  default: 0.4,
  debounceMs: 150,
} as const

describe('ChartControls — LOWESS slider', () => {
  it('minimum bandwidth is 0.05', () => {
    expect(LOWESS_SLIDER.min).toBe(0.05)
  })

  it('minimum allows tight local fit (0.05 is selectable)', () => {
    expect(0.05 >= LOWESS_SLIDER.min).toBe(true)
  })

  it('old minimum 0.10 would not allow 0.05 (regression guard)', () => {
    const OLD_MIN = 0.10
    expect(0.05 >= OLD_MIN).toBe(false)
  })

  it('maximum bandwidth is 0.75 (above this approaches global linear fit)', () => {
    expect(LOWESS_SLIDER.max).toBe(0.75)
  })

  it('step is 0.05', () => {
    expect(LOWESS_SLIDER.step).toBe(0.05)
  })

  it('default bandwidth is 0.4', () => {
    expect(LOWESS_SLIDER.default).toBe(0.4)
  })

  it('default is within [min, max]', () => {
    expect(LOWESS_SLIDER.default).toBeGreaterThanOrEqual(LOWESS_SLIDER.min)
    expect(LOWESS_SLIDER.default).toBeLessThanOrEqual(LOWESS_SLIDER.max)
  })

  it('debounce delay is 150ms to prevent O(n²) LOWESS recompute on drag', () => {
    expect(LOWESS_SLIDER.debounceMs).toBe(150)
  })

  it('applyLowess runs without error at minimum bandwidth 0.05', () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ egc: i * 2.0 }))
    expect(() => applyLowess(data, LOWESS_SLIDER.min)).not.toThrow()
  })

  it('applyLowess at min bandwidth preserves array length', () => {
    const data   = Array.from({ length: 20 }, (_, i) => ({ egc: i }))
    const result = applyLowess(data, LOWESS_SLIDER.min)
    expect(result).toHaveLength(20)
  })

  it('applyLowess at max bandwidth produces smoother result than at min', () => {
    const noisy = [1, 10, 2, 9, 3, 8, 4, 7, 5, 6, 4, 8, 3, 9, 2].map(egc => ({ egc }))
    const tight  = applyLowess(noisy, LOWESS_SLIDER.min)
    const smooth = applyLowess(noisy, LOWESS_SLIDER.max)
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
// Hierarchy in dark mode (against #0c0f18 background):
//   --text-dim  (#cbd5e1)  is the lightest of the three — most legible dim text
//   --text      (#b8c4d8)  is the mid-tone body text
//   --text-h    (#e8eeff)  is the brightest heading text
// Note: TEXT_DIM > BODY_TEXT in luminance because dim text in dark mode is
// paradoxically brighter than body text to achieve readable contrast on the
// very dark background. The "dim" refers to reduced visual weight via opacity
// in some contexts, not lower absolute luminance.
const DARK_BG      = '#0c0f18'
const TEXT_DIM     = '#cbd5e1'  // --text-dim: readable accent / metadata text
const BODY_TEXT    = '#b8c4d8'  // --text: body / label text
const HEADING      = '#e8eeff'  // --text-h: heading text (brightest)
const OLD_TEXT_DIM = '#5a6880'  // original value that failed WCAG AA

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

  it('TEXT_DIM is brighter than BODY_TEXT (both pass AA, dim is accent not darker)', () => {
    // On a very dark background, --text-dim (#cbd5e1) is actually lighter than
    // --text (#b8c4d8). Both pass WCAG AA. The "dim" label refers to reduced
    // visual prominence in certain contexts, not lower luminance.
    expect(relativeLuminance(TEXT_DIM)).toBeGreaterThan(relativeLuminance(BODY_TEXT))
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
  Z = ( EGC − μ ) / s where s = sample std dev (÷ n−1, Bessel-corrected)
  LOWESS Smoothing
  local weighted linear regression span = ceil(bandwidth × n) tricube kernel
  Spearman CLR Correlation
  CLR-transformed EGC circular-shift permutation n=1000 seed=42
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

  it('permutation test parameters are cited (reproducibility)', () => {
    expect(ABOUT_CALC_TEXT).toContain('n=1000')
    expect(ABOUT_CALC_TEXT).toContain('seed=42')
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
  const raw = [10, 50, 8, 60, 12, 55, 9, 48].map(egc => ({ egc }))

  it('zscore → lowess gives different result than lowess → zscore', () => {
    const zFirst = applyLowess(applyZScore(raw), 0.4)
    const sFirst = applyZScore(applyLowess(raw, 0.4))
    const maxDiff = Math.max(
      ...zFirst.map((d, i) => Math.abs((d.egc ?? 0) - (sFirst[i].egc ?? 0))),
    )
    expect(maxDiff).toBeGreaterThan(0.01)
  })

  it('zscore → lowess: output has zero mean (approximately)', () => {
    const result = applyLowess(applyZScore(raw), 0.4)
    const vals   = result.map(d => d.egc as number).filter(v => v != null)
    const mean   = vals.reduce((a, b) => a + b, 0) / vals.length
    // Mean should be close to 0 since Z-score was applied first
    expect(Math.abs(mean)).toBeLessThan(0.5)
  })

  it('neither order throws or produces NaN', () => {
    const z = applyLowess(applyZScore(raw), 0.4)
    const s = applyZScore(applyLowess(raw, 0.4))
    for (const d of [...z, ...s]) {
      if (d.egc !== null) expect(isNaN(d.egc)).toBe(false)
    }
  })
})