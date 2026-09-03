// ── ScaffoldBtn ───────────────────────────────────────────────────────────────
// Small button that opens the ScaffoldModal for a given annotation.
// Used in table rows across Analyze, Explore (top EGC table, by-parent table).
//
// Manages its own open/closed state so the parent only needs to pass
// the annotation ID, source, and optional navigation callback. `name` is
// optional too — when given, ScaffoldModal shows it (bare, italic) as the
// header label for taxonomy instead of the full lineage annotation_id.

import { useState } from 'react'
import type { CSSProperties } from 'react'
import { ScaffoldModal } from './ScaffoldModal'

export function ScaffoldBtn({
  annotationId,
  source,
  name,
  onGoExplore,
  className,
  style,
}: {
  annotationId:  string
  source:        string
  name?:         string | null
  onGoExplore?:  (annotationId: string, source: string) => void
  className?:    string
  style?:        CSSProperties
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        data-testid="scaffold-btn"
        className={className ?? 'btn sm ghost'}
        style={style ?? { fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 8px' }}
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        title={`View scaffolds for ${annotationId}`}
      >
        🧬 Scaffolds
      </button>

      {open && (
        <ScaffoldModal
          annotationId={annotationId}
          source={source}
          name={name}
          onClose={() => setOpen(false)}
          onGoExplore={onGoExplore}
        />
      )}
    </>
  )
}
