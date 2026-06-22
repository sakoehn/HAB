// ── ScaffoldBtn ───────────────────────────────────────────────────────────────
// Small button that opens the ScaffoldModal for a given annotation.
// Used in table rows across Analyze, Explore (top EGC table, by-parent table).
//
// Manages its own open/closed state so the parent only needs to pass
// the annotation ID, source, and optional navigation callback.

import React, { useState } from 'react'
import { ScaffoldModal } from './ScaffoldModal'

export function ScaffoldBtn({
  annotationId,
  source,
  onGoExplore,
}: {
  annotationId:  string
  source:        string
  onGoExplore?:  (annotationId: string, source: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        className="btn sm ghost"
        style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 8px' }}
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        title={`View scaffolds for ${annotationId}`}
      >
        🧬 Scaffolds
      </button>

      {open && (
        <ScaffoldModal
          annotationId={annotationId}
          source={source}
          onClose={() => setOpen(false)}
          onGoExplore={onGoExplore}
        />
      )}
    </>
  )
}
