/**
 * external-links.component.test.tsx
 * ====================================
 * Component tests for ExternalLinks/ExternalLink (components/ui/ExternalLinks.tsx)
 * -- found with zero direct component coverage. This component's actual job
 * is generating correct outbound URLs to real third-party databases (KEGG,
 * NCBI) -- a wrong URL here silently sends a researcher to a broken or
 * unrelated page, so these tests check the real hrefs generated per source,
 * not just that "some link" rendered.
 *
 * Coverage
 * --------
 *   empty/whitespace-only annotation id -> null (no crash)
 *   kegg KO id (K##### shape) gets KEGG + BRITE + Color Mapper (3 links);
 *     Color Mapper copies the id to the clipboard and opens the mapper
 *   kegg non-KO id gets the plain KEGG database link, `map`-prefixed for a
 *     real pathway or `br:ko`-prefixed for a BRITE-only group (W32,
 *     docs/AUDIT-2026-09-22.md -- a bare code 404s on genome.jp)
 *   cog id gets the NCBI COG link
 *   enzyme id gets a dash-padded KEGG link for a partial EC, and an ExPASy
 *     link (not NCBI's discontinued Enzyme database, W32) only for a
 *     complete 4-level EC, with the "EC:" prefix stripped from both
 *   taxonomy id gets the NCBI Taxonomy search link built from the bare
 *     leaf-most rank name, not the full `;`-joined lineage (W32)
 *   unknown source -> null
 *   ExternalLink (inline variant): italicizes taxonomy labels, uses
 *     taxonomyAwarePrimaryLabel for the visible text
 *
 * Run: npx vitest run src/tests/external-links.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ExternalLinks, ExternalLink } from '../components/ui/ExternalLinks'

describe('ExternalLinks — empty/unknown input', () => {
  it('returns nothing for an empty annotation id', () => {
    const { container } = render(<ExternalLinks annotationId="" source="cog" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('returns nothing for a whitespace-only annotation id', () => {
    const { container } = render(<ExternalLinks annotationId="   " source="cog" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('returns nothing for an unrecognized source', () => {
    const { container } = render(<ExternalLinks annotationId="X123" source="not_a_real_source" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ExternalLinks — kegg', () => {
  it('a real KO id gets KEGG + BRITE + Color Mapper, with correct real hrefs', () => {
    render(<ExternalLinks annotationId="K00844" source="kegg" />)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute(
      'href', 'https://www.genome.jp/entry/K00844',
    )
    expect(screen.getByRole('link', { name: 'BRITE' })).toHaveAttribute(
      'href', 'https://www.genome.jp/kegg-bin/show_brite?htext=ko00001.keg&query=K00844',
    )
    expect(screen.getByRole('button', { name: /Color Mapper/i })).toBeInTheDocument()
  })

  // W32: 09101 (Carbohydrate metabolism) is a real BRITE-only organizational
  // group inside ko00001.keg -- it has no standalone pathway map, so it
  // needs the `br:ko` entry prefix, not a bare `map` one.
  it('a non-KO kegg id for a BRITE-only group (09xxx/99xxx) gets a br:ko-prefixed KEGG link', () => {
    render(<ExternalLinks annotationId="09101" source="kegg" />)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute(
      'href', 'https://www.genome.jp/entry/br:ko09101',
    )
    expect(screen.queryByRole('link', { name: 'BRITE' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Color Mapper/i })).not.toBeInTheDocument()
  })

  // W32: 02024 (Quorum sensing) is a real KEGG pathway map, not a BRITE-only
  // group -- confirmed against the audit's own W30 example table.
  it('a non-KO kegg id for a real pathway map gets a map-prefixed KEGG link', () => {
    render(<ExternalLinks annotationId="02024" source="kegg" />)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute(
      'href', 'https://www.genome.jp/entry/map02024',
    )
  })

  it('Color Mapper copies the id to the clipboard and opens the real mapper URL', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    // navigator.clipboard is a getter-only property in jsdom -- redefine it
    // rather than Object.assign, which throws on a getter-only target.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true,
    })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    render(<ExternalLinks annotationId="K00844" source="kegg" />)
    await user.click(screen.getByRole('button', { name: /Color Mapper/i }))

    expect(writeText).toHaveBeenCalledWith('K00844')
    expect(openSpy).toHaveBeenCalledWith(
      'https://www.genome.jp/kegg/mapper/color.html', '_blank', 'noopener',
    )
    openSpy.mockRestore()
  })
})

describe('ExternalLinks — cog', () => {
  it('gets the real NCBI COG entry link', () => {
    render(<ExternalLinks annotationId="COG0001" source="cog" />)
    expect(screen.getByRole('link', { name: 'NCBI COG' })).toHaveAttribute(
      'href', 'https://www.ncbi.nlm.nih.gov/research/cog/cog/COG0001/',
    )
  })
})

describe('ExternalLinks — enzyme', () => {
  // W32: NCBI's own Enzyme database is discontinued (404s for every EC,
  // not just partial ones) -- replaced with the still-live ExPASy ENZYME
  // database, labelled accordingly so the link text matches its real target.
  it('a complete 4-level EC gets a KEGG link and an ExPASy link, EC: prefix stripped from both', () => {
    render(<ExternalLinks annotationId="EC:1.1.1.1" source="enzyme" />)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute(
      'href', 'https://www.genome.jp/entry/ec:1.1.1.1',
    )
    expect(screen.getByRole('link', { name: 'ExPASy' })).toHaveAttribute(
      'href', 'https://enzyme.expasy.org/EC/1.1.1.1',
    )
  })

  it('a bare EC id (no prefix) produces identical urls to the prefixed form', () => {
    render(<ExternalLinks annotationId="1.1.1.1" source="enzyme" />)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute(
      'href', 'https://www.genome.jp/entry/ec:1.1.1.1',
    )
    expect(screen.getByRole('link', { name: 'ExPASy' })).toHaveAttribute(
      'href', 'https://enzyme.expasy.org/EC/1.1.1.1',
    )
  })

  // W32: a partial EC (e.g. "2.7", an EC subclass with no complete 4-level
  // number) 404s on genome.jp without dash-padding, and has no matching
  // per-entry page on ExPASy at all -- confirmed only the (now dash-padded)
  // KEGG link is shown for it.
  it('a partial EC gets a dash-padded KEGG link and no ExPASy link', () => {
    render(<ExternalLinks annotationId="EC:2.7" source="enzyme" />)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute(
      'href', 'https://www.genome.jp/entry/ec:2.7.-.-',
    )
    expect(screen.queryByRole('link', { name: 'ExPASy' })).not.toBeInTheDocument()
  })
})

describe('ExternalLinks — taxonomy', () => {
  // W32: NCBI Taxonomy's search has no match for a full `;`-joined lineage
  // string (confirmed live: "No items found") -- it needs just the
  // leaf-most rank's bare name.
  it('gets the real NCBI Taxonomy search link built from the bare leaf name, not the full lineage', () => {
    render(<ExternalLinks annotationId="Bacteria;Proteobacteria" source="taxonomy" />)
    expect(screen.getByRole('link', { name: 'NCBI Taxonomy' })).toHaveAttribute(
      'href', 'https://www.ncbi.nlm.nih.gov/taxonomy/?term=Proteobacteria',
    )
  })

  it('prefers a real `name` prop over the id-derived leaf segment when given', () => {
    render(<ExternalLinks annotationId="Bacteria;Proteobacteria;Alphaproteobacteria" source="taxonomy" name="Alphaproteobacteria" />)
    expect(screen.getByRole('link', { name: 'NCBI Taxonomy' })).toHaveAttribute(
      'href', 'https://www.ncbi.nlm.nih.gov/taxonomy/?term=Alphaproteobacteria',
    )
  })
})

describe('ExternalLink — inline variant', () => {
  it('italicizes the label for a taxonomy annotation', () => {
    render(<ExternalLink annotationId="Bacteria;Proteobacteria" source="taxonomy" name="Proteobacteria" />)
    const label = screen.getByText('Proteobacteria')
    expect(label.style.fontStyle).toBe('italic')
  })

  it('does not italicize the label for a non-taxonomy annotation', () => {
    render(<ExternalLink annotationId="COG0001" source="cog" name="GroEL" />)
    const label = screen.getByText('COG0001')
    expect(label.style.fontStyle).toBe('normal')
  })

  it('still renders its ExternalLinks badges alongside the label', () => {
    render(<ExternalLink annotationId="COG0001" source="cog" name="GroEL" />)
    expect(screen.getByRole('link', { name: 'NCBI COG' })).toBeInTheDocument()
  })

  // W32: ExternalLink already computes a taxonomy `name` for its own visible
  // label -- confirms that same value is threaded into ExternalLinks' NCBI
  // Taxonomy URL too, not just used for display.
  it('passes its taxonomy name prop through to the NCBI Taxonomy link', () => {
    render(<ExternalLink annotationId="Bacteria;Proteobacteria" source="taxonomy" name="Proteobacteria" />)
    expect(screen.getByRole('link', { name: 'NCBI Taxonomy' })).toHaveAttribute(
      'href', 'https://www.ncbi.nlm.nih.gov/taxonomy/?term=Proteobacteria',
    )
  })
})
