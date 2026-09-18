// ── HierarchyModal ────────────────────────────────────────────────────────────
// Popup showing where one KEGG/COG/Enzyme annotation sits in its source's
// BRITE-style hierarchy. Shell copied from ScaffoldModal.tsx (overlay,
// escape-to-close, click-outside-to-close, header layout) -- much simpler
// body: on open, fetches every real ancestor path for the annotation and
// auto-expands the first (file-order-primary) one, highlighting the leaf.
//
// KEGG nodes can have multiple real parents (E14 -- e.g. K00844/hexokinase
// has 14 real pathway parents); when that's the case (path_count > 1) a
// dropdown above the tree lists every real path, labelled by whichever
// segment actually differs between them (its immediate parent) -- picking
// one switches the tree to that path instead.

import { useEffect, useState } from 'react'

import type { HierarchySource } from '../../types'
import { SOURCE_TAG_CLS } from '../../constants'
import { useHierarchyTree } from '../../hooks/useHierarchyTree'
import { HierarchyTree } from './HierarchyTree'
import { SkeletonTreeRows } from '../ui/Skeleton'

export function HierarchyModal({
  annotationId,
  source,
  name,
  onClose,
}: {
  annotationId: string
  source:       HierarchySource
  name?:        string | null
  onClose:      () => void
}) {
  const {
    nodes, highlightId, paths, selectedPathIndex,
    toggleExpand, expandToPath, switchToPath,
  } = useHierarchyTree(source)
  const [pathStatus, setPathStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [pathCount, setPathCount]   = useState(1)

  useEffect(() => {
    let cancelled = false
    setPathStatus('loading')
    expandToPath(annotationId).then(result => {
      if (cancelled) return
      if (result === null) { setPathStatus('error'); return }
      setPathCount(result.pathCount)
      setPathStatus('ok')
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationId])

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div
      className="scaffold-modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="scaffold-modal" data-testid="hierarchy-modal" role="dialog">

        {/* ── Modal header ── */}
        <div className="scaffold-modal-header" data-testid="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1, flexWrap: 'wrap' }}>
            <span
              data-testid="annotation-id"
              title={annotationId}
              style={{ font: '600 14px var(--mono)', color: 'var(--teal)' }}
            >
              {annotationId}
            </span>
            {name && (
              <span style={{ font: '12px var(--sans)', color: 'var(--text-dim)' }}>{name}</span>
            )}
            <span data-testid="source-tag" className={`tag ${SOURCE_TAG_CLS[source] ?? ''}`}>{source}</span>
            <span style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>· Hierarchy</span>
          </div>
          <button data-testid="close-btn" className="btn sm ghost" onClick={onClose}>✕ Close</button>
        </div>

        {/* ── Modal body ──
             The picker lives OUTSIDE the tree's own scroll container
             (not just the same div with overflow) so auto-scroll-to-
             highlight never pushes it out of view -- it needs to stay
             reachable exactly when the user most wants to use it (right
             after landing on a multi-parent node). */}
        <div className="scaffold-modal-body" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
          {pathStatus === 'loading' && (
            <div style={{ padding: '12px 16px' }}>
              <span className="sr-only">Loading hierarchy…</span>
              <SkeletonTreeRows rows={5} />
            </div>
          )}
          {pathStatus === 'error' && (
            <div className="state-box error" data-testid="error-state" style={{ padding: 32 }}>
              <div className="state-icon">⚠</div>
              <span>Could not locate {annotationId} in the {source} hierarchy.</span>
            </div>
          )}
          {pathStatus === 'ok' && pathCount > 1 && (
            <div
              data-testid="multi-parent-note"
              style={{
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                padding: '10px 16px', borderBottom: '1px solid var(--border)',
                background: 'var(--surface2)', flexShrink: 0,
              }}
            >
              <span style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>
                {annotationId} appears under {pathCount} real KEGG pathways:
              </span>
              <select
                data-testid="path-picker"
                className="field"
                style={{ font: '12px var(--mono)', padding: '2px 6px', width: 'auto' }}
                value={selectedPathIndex}
                onChange={e => switchToPath(Number(e.target.value))}
              >
                {paths.map((path, i) => {
                  const label = path.length >= 2 ? path[path.length - 2].name : path[0].name
                  return (
                    <option key={i} value={i}>{i + 1}. {label}</option>
                  )
                })}
              </select>
            </div>
          )}
          {pathStatus === 'ok' && (
            <div style={{ padding: '12px 16px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
              <HierarchyTree nodes={nodes} highlightId={highlightId} onToggleExpand={toggleExpand} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
