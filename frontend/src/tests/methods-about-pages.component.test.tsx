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

  // A lag shifts by whole samples, and the three sampling gaps (8 h, 8 h,
  // 12 h) make some shifted pairs further apart than samples x 4 h.
  it('says lag hours are nominal and how far the sampling gaps stretch them', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/nominal/i)
    expect(text).toContain('up to 8 h')
    expect(text).not.toContain('up to a full day')
  })

  // For an unrelated pair the best-|r| lag is mostly chance and tends to
  // the window edge; a lag at the edge may really be longer.
  it('says the lag of a non-significant pair is mostly chance, and what an edge lag means', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/not significant[^.]*chance/i)
    expect(text).toMatch(/edge of the window/i)
    expect(text).toContain('24h+')
  })

  // Rates measured with the app's scoring code on 2,000 simulated pairs.
  it('states the measured false-positive rates, not "about half"', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).not.toContain('about half of unrelated')
    expect(text).toMatch(/about 40%[^.]*one lag[^.]*about 80%/)
    expect(text).toMatch(/about 6% pass p < 0\.05 rather than 5%, up to\s+7% when a candidate is detected in only part/)
    expect(text).toMatch(/kept as\s+published, and the false discovery rate correction/)
  })

  it('says the checked-taxa download leaves out a taxon inside another checked one', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/only the higher one is downloaded/)
    expect(text).toMatch(/check only the families/)
  })

  it('explains the KEGG by taxon download: sums, shared norm_egc total, zeros, best-match taxa', () => {
    render(<MethodsPage />)
    expect(screen.getByText('KEGG by taxon', { selector: 'strong' })).toBeInTheDocument()
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/a KO’s taxa add up to the KO’s\s+own value at every timepoint/)
    expect(text).toMatch(/share of the annotated genes only/)
    expect(text).toMatch(/below detection, not proof the taxon or gene was absent/)
    expect(text).toMatch(/JGI’s best match/)
  })

  it('says a series too short to smooth is drawn unsmoothed', () => {
    const { container } = render(<MethodsPage />)
    expect(container.textContent).toMatch(/fewer than 4 detected points is drawn unsmoothed/)
  })

  it('says sample times are local Pacific time', () => {
    const { container } = render(<MethodsPage />)
    expect(container.textContent).toMatch(/local Pacific Daylight Time \(UTC−7\)/)
  })

  it('says how a chart CSV picks the tide value for each sample', () => {
    const { container } = render(<MethodsPage />)
    expect(container.textContent).toMatch(/reading nearest the sample’s time, left blank if none is within 30 minutes/)
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

  it('says which candidates are scored and that weaker ones are still listed', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/Every candidate in the family is tested/)
    expect(text).toMatch(/fewer than 10 detected timepoints/i)
    expect(text).toMatch(/how many could not be/i)
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

  it('explains what a correlation across sources can mean, with the measured examples', () => {
    const { container } = render(<MethodsPage />)
    const text = (container.textContent ?? '').replace(/\s+/g, ' ')
    expect(titles()).toContain('What a correlation across sources can mean')
    // Shared genes: measured on the real database, EGC.
    expect(text).toMatch(/K00844\) and EC 2\.7\.1\.1 are the same 154 genes \(r = 1\.00\)/)
    expect(text).toMatch(/EC 1\.10\.3\.9 \(r = 0\.98\)/)
    expect(text).toMatch(/EC 3\.5\.1\.5 \(r = 0\.98\)/)
    expect(text).toMatch(/on EGC; all three methods give the same value to within 0\.02/)
    // Taxonomy: who carries the gene.
    expect(text).toMatch(/87% of psbA genes are cyanobacterial/)
    expect(text).toMatch(/r = 0\.70 on EGC/)
    // Relative abundance is a share of a shared total.
    expect(text).toMatch(/varies 6\.8-fold/)
    expect(text).toMatch(/94–99%/)
    expect(text).toMatch(/r = 0\.39–0\.53 on relative abundance/)
    expect(text).toMatch(/checking against EGC/)
  })

  it('places the cross-source item right after the same-source exclusions', () => {
    const t = titles()
    expect(t.indexOf('What a correlation across sources can mean')).toBe(
      t.indexOf('Which candidates are compared') + 1,
    )
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

  it('lists all six Explore views, Bulk Download included', () => {
    const { container } = render(<AboutPage />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/Explore: Six views/)
    expect(text).toMatch(/Scaffold Information, and Bulk Download/)
  })

  it('API reference lists the KEGG by taxon download and its size route', () => {
    const { container } = render(<AboutPage />)
    const text = container.textContent ?? ''
    expect(text).toMatch(/\/api\/series\/export\/by-taxon\?rank=genus&format=long/)
    expect(text).toMatch(/\/api\/series\/export\/by-taxon\/summary\?rank=genus/)
    expect(text).toMatch(/selection=\{"kos": \[KO, …\]\}/)
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
