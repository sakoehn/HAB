// ── AnnotationInfoDrawer ──────────────────────────────────────────────────────
// Collapsible metadata drawer shown below each chart card header in Analyze.
// Toggled by the ℹ button in the card header.
//
// Displays:
//   - Annotation ID (monospace, teal)
//   - Human-readable name
//   - Parent category (expanded via expandParentLabel)
//   - Source tag
//   - External database links
//
// Designed to be reusable — takes only the four metadata fields it needs,
// no dependency on page-level state.

import React, { useState } from 'react'

import { SOURCE_TAG_CLS, expandParentLabel } from '../../constants'
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
              <span className="card-info-value">{name}</span>
            </div>
          )}

          {parent && (
            <div className="card-info-row">
              <span className="card-info-label">Parent</span>
              <span className="card-info-value">
                {expandParentLabel(parent, source)}
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
              <ExternalLinks annotationId={annotationId} source={source} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
