// ── AnnotationInfoDrawer ──────────────────────────────────────────────────────
// Collapsible metadata drawer shown below each chart card header in Analyze.
// Toggled by the ℹ button in the card header.
//
// Displays:
//   - Annotation ID (monospace, teal)
//   - Human-readable name (or, for a KO JGI never names, a pointer to its
//     KEGG page)
//   - Old EC number(s) JGI's files use, for a renumbered enzyme
//   - Parent category (expanded via expandParentLabel)
//   - Source tag
//   - External database links
//
// Designed to be reusable — takes only the four metadata fields it needs,
// no dependency on page-level state.

import { useEffect, useState } from 'react'

import type { HierarchyPathResponse } from '../../types'
import { SOURCE_TAG_CLS, expandParentLabel, ecRenumberedNote, EC_RENUMBERED_FROM } from '../../constants'
import { apiFetch } from '../../utils/api'
import { ExternalLinks } from '../ui/ExternalLinks'

export function AnnotationInfoDrawer({
  annotationId,
  source,
  name,
  parent,
}: {
  annotationId: string
  source:       string
  name:         string | null
  parent:       string | null
}) {
  const [open, setOpen] = useState(false)
  const renumberedNote = ecRenumberedNote(source, annotationId)
  // `parent` is the single, last-occurrence-wins stored value -- a
  // multi-category COG (e.g. COG0028 under both category E and H) has more
  // than one real immediate parent. Mirrors the fetch Explore's own Lookup
  // card uses (cog_paths, built for the hierarchy popup, holds every real
  // path). Enzyme/taxonomy are never multi-parent (an EC number has one
  // class; taxonomy's parent is a full lineage-prefix), and a KEGG KO has
  // no parent at all, so only cog needs this.
  const [realParents, setRealParents] = useState<{ annotation_id: string; name: string }[]>([])
  const [realParentsStatus, setRealParentsStatus] = useState<'idle' | 'ok' | 'failed'>('idle')
  const multiParent = source === 'cog'
  // cog shows the real categories once loaded, and the stored value only
  // if that fetch failed -- never the stored value while it is loading,
  // since it names just one of a multi-category COG's categories.
  const parentLabels: string[] | null = !multiParent || realParentsStatus === 'failed'
    ? (parent ? [expandParentLabel(parent, source)] : null)
    : realParentsStatus === 'ok' && realParents.length > 0
      ? realParents.map(p => p.name)
      : null

  useEffect(() => {
    if (!open || realParentsStatus !== 'idle') return
    if (source !== 'cog') return
    apiFetch<HierarchyPathResponse>(`/api/${source}/path?id=${encodeURIComponent(annotationId)}`)
      .then(r => {
        const depth = r.paths[0]?.length ?? 0
        const byId = new Map<string, { annotation_id: string; name: string }>()
        if (depth >= 2) {
          for (const path of r.paths) {
            const immediate = path[depth - 2]
            if (immediate) byId.set(immediate.annotation_id, immediate)
          }
        }
        setRealParents([...byId.values()])
        setRealParentsStatus('ok')
      })
      .catch(() => setRealParentsStatus('failed')) // fall back to the stored single value below
  }, [open, source, annotationId, realParentsStatus])

  return (
    <>
      <button
        className={`card-info-btn ${open ? 'card-info-btn-active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Show annotation details and database links"
      >
        ℹ
      </button>

      {open && (
        <div className="card-info-drawer expand-anim">
          <div className="card-info-row">
            <span className="card-info-label">ID</span>
            <span className="card-info-value mono">{annotationId}</span>
          </div>

          {name && (
            <div className="card-info-row">
              <span className="card-info-label">Name</span>
              <span
                className="card-info-value"
                style={source === 'taxonomy' ? { fontStyle: 'italic' } : undefined}
              >
                {name}
              </span>
            </div>
          )}

          {!name && source === 'kegg' && (
            <div className="card-info-row" data-testid="info-kegg-no-name">
              <span className="card-info-label">Name</span>
              <span className="card-info-value">
                JGI gives this KO no name — see its KEGG page below.
              </span>
            </div>
          )}

          {renumberedNote && (
            <div className="card-info-row" data-testid="info-ec-renumbered">
              <span className="card-info-label">Old EC number</span>
              <span className="card-info-value mono" title={renumberedNote}>
                {EC_RENUMBERED_FROM[annotationId].join(', ')}
              </span>
            </div>
          )}

          {parentLabels && (
            <div className="card-info-row">
              <span className="card-info-label">
                {parentLabels.length > 1 ? 'Parents' : 'Parent'}
              </span>
              <span className="card-info-value">
                {parentLabels.join(', ')}
              </span>
            </div>
          )}

          <div className="card-info-row">
            <span className="card-info-label">Source</span>
            <span className={`tag ${SOURCE_TAG_CLS[source] ?? ''}`}>
              {source}
            </span>
          </div>

          <div className="card-info-row card-info-links-row">
            <span className="card-info-label">Links</span>
            <div className="card-info-links">
              <ExternalLinks annotationId={annotationId} source={source} name={name} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
