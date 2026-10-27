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

  it('states the real lag window and permutation scheme, not the stale ones', () => {
    const { container } = render(<MethodsPage />)
    const text = container.textContent ?? ''
    const n = METHODS_FACTS.correlationLags.length
    const maxLag = Math.max(...METHODS_FACTS.correlationLags)
    expect(text).toContain(`${n} lags`)
    expect(text).toContain(`±${maxLag} samples`)
    expect(text).toContain(`top ${METHODS_FACTS.circularShiftScreenTopN}`)
    expect(text).not.toMatch(/\b9 lags\b/)
    expect(text).not.toMatch(/1000 random/i)
  })
})

describe('MethodsPage — every correlation method is described', () => {
  it('has its own item for raw Pearson, log-Pearson, Spearman and the circular shift', () => {
    const { container } = render(<MethodsPage />)
    const titles = [...container.querySelectorAll('strong')].map(el => el.textContent)
    for (const t of ['Raw Pearson', 'Log-Pearson', 'Spearman', 'Circular-shift p-value']) {
      expect(titles).toContain(t)
    }
  })

  it('says the three classic p-values assume independent timepoints', () => {
    const { container } = render(<MethodsPage />)
    expect(container.textContent).toMatch(/independent/i)
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
})
