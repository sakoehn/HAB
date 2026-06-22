// ── ExternalLinks ─────────────────────────────────────────────────────────────
// Renders clickable badge links to source databases for a given annotation ID.
// All links open in a new tab and never disrupt the portal.
//
// Exports:
//   ExternalLinks  — returns link badges as a React node, or null if no links
//   ExternalLink   — inline version: ID styled in teal + badge links beside it

import React from 'react'

// ── link helper ────────────────────────────────────────────────────────────
// Shared anchor factory used by all source branches below.

function link(href: string, label: string, title: string): React.ReactNode {
  return (
    <a
      key={label}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="ext-link"
      title={title}
      onClick={e => e.stopPropagation()}
    >
      {label}
    </a>
  )
}

// ── ExternalLinks ──────────────────────────────────────────────────────────
// Returns one or more database link badges for an annotation ID, or null
// when no links are defined for that source.
//
// KEGG KO entries also get a "Color Mapper ⎘" button that copies the ID to
// the clipboard then opens the KEGG Color Mapper — the user pastes the ID
// into the Objects box to highlight the pathway map.

export function ExternalLinks({
  annotationId,
  source,
}: {
  annotationId: string
  source:       string
}): React.ReactNode {
  const id = annotationId.trim()
  if (!id) return null

  if (source === 'kegg') {
    const isKO    = /^K\d{5}$/.test(id)
    const links: React.ReactNode[] = []

    if (isKO) {
      links.push(link(
        `https://www.genome.jp/entry/${id}`,
        'KEGG',
        'KEGG Orthology entry',
      ))
      links.push(link(
        `https://www.genome.jp/kegg-bin/show_brite?htext=ko00001.keg&query=${id}`,
        'BRITE',
        'Find in KEGG BRITE functional hierarchy',
      ))
      links.push(
        <button
          key="mapper"
          className="ext-link"
          title={`Copy ${id} to clipboard then open KEGG Color Mapper — paste into the Objects box`}
          onClick={async (e) => {
            e.stopPropagation()
            try { await navigator.clipboard.writeText(id) } catch {}
            window.open(
              'https://www.genome.jp/kegg/mapper/color.html',
              '_blank',
              'noopener',
            )
          }}
        >
          Color Mapper ⎘
        </button>,
      )
    } else {
      links.push(link(
        `https://www.genome.jp/entry/${id}`,
        'KEGG',
        'KEGG database entry',
      ))
    }

    return <>{links}</>
  }

  if (source === 'cog') {
    return link(
      `https://www.ncbi.nlm.nih.gov/research/cog/cog/${id}/`,
      'NCBI COG',
      'NCBI COG database entry',
    )
  }

  if (source === 'enzyme') {
    const ec = id.replace(/^EC:/i, '')
    return (
      <>
        {link(
          `https://www.genome.jp/entry/ec:${ec}`,
          'KEGG',
          'KEGG ENZYME entry',
        )}
        {link(
          `https://www.ncbi.nlm.nih.gov/enzyme/?term=${encodeURIComponent(ec)}`,
          'NCBI',
          'NCBI Enzyme search',
        )}
      </>
    )
  }

  if (source === 'taxonomy') {
    return link(
      `https://www.ncbi.nlm.nih.gov/taxonomy/?term=${encodeURIComponent(id)}`,
      'NCBI Taxonomy',
      'Search NCBI Taxonomy',
    )
  }

  return null
}

// ── ExternalLink ───────────────────────────────────────────────────────────
// Inline version — renders the annotation ID styled in teal alongside its
// external database badge links.  Used in the correlates panel rows.

export function ExternalLink({
  annotationId,
  source,
}: {
  annotationId: string
  source:       string
}) {
  return (
    <span
      style={{
        display:    'inline-flex',
        alignItems: 'center',
        gap:        4,
        flexWrap:   'wrap',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize:   12,
          color:      'var(--teal)',
          fontWeight: 600,
        }}
      >
        {annotationId}
      </span>
      <ExternalLinks annotationId={annotationId} source={source} />
    </span>
  )
}
