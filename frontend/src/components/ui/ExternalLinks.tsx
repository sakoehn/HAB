// ── ExternalLinks ─────────────────────────────────────────────────────────────
// Renders clickable badge links to source databases for a given annotation ID.
// All links open in a new tab and never disrupt the portal.
//
// Exports:
//   ExternalLinks  — returns link badges as a React node, or null if no links
//   ExternalLink   — inline version: primary label (annotation_id, or the
//     bare taxon name when source is 'taxonomy' — see taxonomyAwarePrimaryLabel)
//     styled in teal, full annotation_id always on hover, + badge links beside it

import React from 'react'
import { taxonomyAwarePrimaryLabel } from '../../constants'

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
  name,
}: {
  annotationId: string
  source:       string
  name?:        string | null
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
      // W32 (docs/AUDIT-2026-09-22.md): a bare code like `genome.jp/entry/00010`
      // returns "No such data" -- KEGG requires an `entry`-type prefix. Real
      // pathway maps (e.g. 00010 Glycolysis, 02024 Quorum sensing) use `map`;
      // codes reserved purely for BRITE-only organizational groups (Brite
      // Hierarchies, Not included in regular maps, Unclassified...) have no
      // standalone pathway map and use `br:ko` instead. Confirmed against
      // every code the audit itself cited: pathway maps fall below 09000,
      // BRITE-only groups are the 09xxx/99xxx ranges (09100 Metabolism, 09180
      // Brite Hierarchies, 99980/99996 Unclassified -- all real examples from
      // W30's own BRITE code table).
      const numeric = /^\d{5}$/.test(id) ? Number(id) : null
      const isBriteOnlyGroup = numeric !== null && numeric >= 9000
      links.push(link(
        isBriteOnlyGroup
          ? `https://www.genome.jp/entry/br:ko${id}`
          : `https://www.genome.jp/entry/map${id}`,
        'KEGG',
        isBriteOnlyGroup ? 'KEGG BRITE hierarchy group' : 'KEGG pathway map',
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
    // W32: a partial EC (e.g. "2.7") isn't a valid genome.jp entry on its
    // own -- KEGG's own convention for an EC class page pads the missing
    // levels with dashes ("ec:2.7.-.-").
    const parts   = ec.split('.')
    const keggEc  = [...parts, '-', '-', '-'].slice(0, 4).join('.')
    const isFullEc = parts.length === 4 && parts.every(p => /^\d+$/.test(p))
    return (
      <>
        {link(
          `https://www.genome.jp/entry/ec:${keggEc}`,
          'KEGG',
          'KEGG ENZYME entry',
        )}
        {isFullEc && link(
          `https://enzyme.expasy.org/EC/${ec}`,
          'ExPASy',
          'ExPASy ENZYME entry',
        )}
      </>
    )
  }

  if (source === 'taxonomy') {
    // W32: NCBI Taxonomy search has no match for a full `;`-joined lineage
    // string -- it needs just the leaf-most rank's bare name, the same
    // value already shown as this annotation's own display label elsewhere.
    const leafName = taxonomyAwarePrimaryLabel(source, id, name)
    return link(
      `https://www.ncbi.nlm.nih.gov/taxonomy/?term=${encodeURIComponent(leafName)}`,
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
  name,
}: {
  annotationId: string
  source:       string
  name?:        string | null
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
        title={annotationId}
        style={{
          fontFamily: 'var(--mono)',
          fontSize:   12,
          color:      'var(--teal)',
          fontWeight: 600,
          fontStyle:  source === 'taxonomy' ? 'italic' : 'normal',
          overflowWrap: 'anywhere',
        }}
      >
        {taxonomyAwarePrimaryLabel(source, annotationId, name)}
      </span>
      <ExternalLinks annotationId={annotationId} source={source} name={name} />
    </span>
  )
}
