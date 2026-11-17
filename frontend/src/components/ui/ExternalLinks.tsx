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
    // Every KEGG id is a KO. KEGG's own pages show its name, gene symbol and
    // the pathways it belongs to, which Metatrace does not.
    if (!/^K\d{5}$/.test(id)) return null
    return (
      <>
        {link(
          `https://www.kegg.jp/entry/${id}`,
          'KEGG',
          'KEGG Orthology entry (name, gene symbol, pathways)',
        )}
        {link(
          `https://www.kegg.jp/kegg-bin/show_brite?htext=ko00001.keg&query=${id}`,
          'BRITE',
          'Find in KEGG BRITE functional hierarchy',
        )}
        <button
          key="mapper"
          className="ext-link"
          title={`Copy ${id} to clipboard then open KEGG Color Mapper — paste into the Objects box`}
          onClick={async (e) => {
            e.stopPropagation()
            try { await navigator.clipboard.writeText(id) } catch {}
            window.open(
              'https://www.kegg.jp/kegg/mapper/color.html',
              '_blank',
              'noopener',
            )
          }}
        >
          Color Mapper ⎘
        </button>
      </>
    )
  }

  if (source === 'cog') {
    // The 25 functional categories are single letters, with their own page.
    if (/^[A-Z]$/.test(id)) {
      return link(
        `https://www.ncbi.nlm.nih.gov/research/cog/cogcategory/${id}/`,
        'NCBI COG',
        'NCBI COG functional category',
      )
    }
    return link(
      `https://www.ncbi.nlm.nih.gov/research/cog/cog/${id}/`,
      'NCBI COG',
      'NCBI COG database entry',
    )
  }

  if (source === 'enzyme') {
    const ec = id.replace(/^EC:/i, '')
    const parts    = ec.split('.')
    const isFullEc = parts.length === 4 && parts.every(p => /^\d+$/.test(p))
    // An EC category (e.g. "2.7") has no KEGG ENZYME entry -- genome.jp
    // answers "No such data" -- but ExPASy has a page for every class,
    // subclass and sub-subclass, with the missing levels as dashes
    // ("2.7.-.-"), listing the enzymes under it.
    if (!isFullEc) {
      return link(
        `https://enzyme.expasy.org/EC/${[...parts, '-', '-', '-'].slice(0, 4).join('.')}`,
        'ExPASy',
        'ExPASy ENZYME class page',
      )
    }
    return (
      <>
        {link(
          `https://www.genome.jp/entry/ec:${ec}`,
          'KEGG',
          'KEGG ENZYME entry',
        )}
        {link(
          `https://enzyme.expasy.org/EC/${ec}`,
          'ExPASy',
          'ExPASy ENZYME entry',
        )}
      </>
    )
  }

  if (source === 'taxonomy') {
    // NCBI Taxonomy search has no match for a full `;`-joined lineage
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
