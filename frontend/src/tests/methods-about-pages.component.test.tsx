/**
 * methods-about-pages.component.test.tsx
 * ========================================
 * UI round 2026-10-14: the old single About page is split into a Methods page
 * (annotation types, how every value is calculated and why, data sources)
 * and an About & API page (description, how to use, API reference,
 * authors/contributors). The "Data Updates" section is removed.
 *
 * The Methods page's key numbers live in METHODS_FACTS; tests/
 * test_methods_page_facts.py checks them against the backend's real config,
 * and this file checks the page actually renders them -- so the copy can't
 * silently drift from the code again (the old page said 9 lags and 1000
 * random shifts long after both had changed).
 *
 * Run: npx vitest run src/tests/methods-about-pages.component.test.tsx
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MethodsPage } from '../pages/MethodsPage'
import { METHODS_FACTS } from '../pages/methodsFacts'
import { AboutPage } from '../pages/AboutPage'
import { NAV_ITEMS } from '../constants'

describe('navigation', () => {
  it('has a Methods page before About & API', () => {
    const ids = NAV_ITEMS.map(n => n.id)
    expect(ids).toContain('methods')
    expect(ids.indexOf('methods')).toBe(ids.indexOf('about') - 1)
    expect(NAV_ITEMS.find(n => n.id === 'methods')!.label).toBe('Methods')
  })
})

describe('MethodsPage', () => {
  it('has the methods sections', () => {
    render(<MethodsPage />)
    for (const h of ['Annotation Types', 'From Genes to Annotations', 'How Values Are Calculated', 'Correlation', 'Data Sources']) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument()
    }
  })

  it('states the real lag window, not the stale one', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    const n = METHODS_FACTS.correlationLags.length
    const maxLag = Math.max(...METHODS_FACTS.correlationLags)
    expect(text).toContain(`${n} lags`)
    expect(text).toContain(`±${maxLag} samples`)
    expect(text).not.toMatch(/\b9 lags\b/)
    expect(text).not.toMatch(/1000 random/i)
  })

  it('states the real result limits', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).toContain(`top ${METHODS_FACTS.familyLimitDefault}`)
    expect(text).toContain(`up to ${METHODS_FACTS.familyLimitMax}`)
  })
})

describe('MethodsPage — every calculation is described', () => {
  it('has its own item for each value the charts and tables show', () => {
    const { container } = render(<MethodsPage />)
    const titles = [...container.querySelectorAll('strong')].map(el => el.textContent)
    for (const t of [
      'EGC — Estimated Gene Copies', 'Relative Abundance (norm_egc)', 'Z-score Normalisation',
      'LOWESS Smoothing', 'Descriptive Statistics',
    ]) {
      expect(titles).toContain(t)
    }
    expect(container.textContent).toMatch(/Bessel-corrected/)
  })
})

describe('MethodsPage — every correlation method is described', () => {
  function titles() {
    const { container } = render(<MethodsPage />)
    return [...container.querySelectorAll('strong')].map(el => el.textContent)
  }

  it('has its own item for raw Pearson, log-Pearson and Spearman, and none for the circular shift', () => {
    const t = titles()
    for (const name of ['Raw Pearson', 'Log-Pearson', 'Spearman']) expect(t).toContain(name)
    expect(t).not.toContain('Circular-shift p-value')
  })

  it('explains the effective-sample-size p-value and its source', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(titles()).toContain('P-values: effective sample size')
    expect(text).toMatch(/Pyper & Peterman \(1998\)/)
    expect(text).toMatch(/not independent/i)
  })

  it('states the ~30-effective-samples limit and what it means for |r|', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/about 30 independent/i)
    expect(text).toMatch(/only strong correlations/i)
  })

  it('says every candidate is tested and weaker ones are still listed', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/every candidate/i)
    expect(text).toMatch(/not significant/i)
    expect(text).toMatch(/significant candidates first/i)
  })

  it('describes the per-pair lag correction, not a flat × 13, and that shared trends count', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/Li & Ji 2005/)
    expect(text).toMatch(/but not always by 13/)
    expect(text).not.toMatch(/× ?13/)
    expect(text).toMatch(/shared across the bloom count as a\s+real relationship/i)
  })

  it('no longer describes the permutation test or its shortlist', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/circular|permutation|shortlist|at_p_floor/i)
  })
})

describe('AboutPage', () => {
  it('keeps description, how-to, API reference and an authors section; drops the rest', () => {
    render(<AboutPage />)
    for (const h of ['About Metatrace', 'How to Use', 'API Reference', 'Authors & Contributors']) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument()
    }
    for (const gone of ['Data Updates', 'How Values Are Calculated', 'Annotation Types']) {
      expect(screen.queryByRole('heading', { name: gone })).not.toBeInTheDocument()
    }
  })

  it('API reference no longer claims an inverted index or 26 COG categories', () => {
    const { container } = render(<AboutPage />)
    expect(container.textContent).not.toMatch(/inverted index/i)
    expect(container.textContent).not.toMatch(/26 top-level categories/)
  })

  it('API reference describes the current correlation methods and family response', () => {
    const { container } = render(<AboutPage />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/circular_shift|prescreen/)
    expect(text).toMatch(/raw_pearson, log_pearson or spearman/)
    expect(text).toMatch(/significant_count, tested_count/)
    expect(text).toMatch(/significant \(q < 0\.05\)/)
    expect(text).toMatch(/significant ones first/)
  })
})
