// ── HierarchyBtn ─────────────────────────────────────────────────────────────
// Small button that opens the HierarchyModal for a given KEGG/COG/Enzyme
// annotation. Modeled directly on ScaffoldBtn.tsx (self-contained open/
// closed state).
//
// Renders nothing for source === 'taxonomy' -- taxonomy already has its own
// dedicated tree UI (TaxonomyPage/TaxonomyTree), so call sites don't need
// their own conditional to hide this button for taxonomy rows.

import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { HierarchySource } from '../../types'
import { HierarchyModal } from './HierarchyModal'

const HIERARCHY_SOURCES: readonly string[] = ['kegg', 'cog', 'enzyme']

function isHierarchySource(source: string): source is HierarchySource {
  return HIERARCHY_SOURCES.includes(source)
}

export function HierarchyBtn({
  annotationId,
  source,
  name,
  className,
  style,
}: {
  annotationId: string
  source:       string
  name?:        string | null
  className?:   string
  style?:       CSSProperties
}) {
  const [open, setOpen] = useState(false)

  if (!isHierarchySource(source)) return null

  return (
    <>
      <button
        data-testid="hierarchy-btn"
        className={className ?? 'btn sm ghost'}
        style={style ?? { fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 8px' }}
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        title={`View ${annotationId} in the ${source} hierarchy`}
      >
        🌳 Hierarchy
      </button>

      {open && (
        <HierarchyModal
          annotationId={annotationId}
          source={source}
          name={name}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
