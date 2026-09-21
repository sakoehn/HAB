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
 *   kegg non-KO id gets only the plain KEGG database link
 *   cog id gets the NCBI COG link
 *   enzyme id gets both KEGG and NCBI links, with the "EC:" prefix
 *     stripped from both urls (not just one)
 *   taxonomy id gets the NCBI Taxonomy search link
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

  it('a non-KO kegg id (e.g. a pathway/BRITE code) gets only the plain KEGG link', () => {
    render(<ExternalLinks annotationId="09101" source="kegg" />)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute(
      'href', 'https://www.genome.jp/entry/09101',
    )
    expect(screen.queryByRole('link', { name: 'BRITE' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Color Mapper/i })).not.toBeInTheDocument()
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
  it('strips the EC: prefix for both the KEGG and NCBI urls', () => {
    render(<ExternalLinks annotationId="EC:1.1.1.1" source="enzyme" />)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute(
      'href', 'https://www.genome.jp/entry/ec:1.1.1.1',
    )
    expect(screen.getByRole('link', { name: 'NCBI' })).toHaveAttribute(
      'href', 'https://www.ncbi.nlm.nih.gov/enzyme/?term=1.1.1.1',
    )
  })

  it('a bare EC id (no prefix) produces identical urls to the prefixed form', () => {
    render(<ExternalLinks annotationId="1.1.1.1" source="enzyme" />)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute(
      'href', 'https://www.genome.jp/entry/ec:1.1.1.1',
    )
    expect(screen.getByRole('link', { name: 'NCBI' })).toHaveAttribute(
      'href', 'https://www.ncbi.nlm.nih.gov/enzyme/?term=1.1.1.1',
    )
  })
})

describe('ExternalLinks — taxonomy', () => {
  it('gets the real NCBI Taxonomy search link, URL-encoded', () => {
    render(<ExternalLinks annotationId="Bacteria;Proteobacteria" source="taxonomy" />)
    expect(screen.getByRole('link', { name: 'NCBI Taxonomy' })).toHaveAttribute(
      'href', 'https://www.ncbi.nlm.nih.gov/taxonomy/?term=Bacteria%3BProteobacteria',
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
})
