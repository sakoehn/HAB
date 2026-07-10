// ── HelpTooltip ────────────────────────────────────────────────────────────────
// Small "?" click-to-reveal badge used to explain non-obvious controls
// throughout the app. Generalizes the icon-button + toggle-panel shape from
// AnnotationInfoDrawer.tsx into a reusable, content-agnostic component.
//
// Click-to-reveal (not hover) so it works on touch devices, unlike the
// native `title` attribute used elsewhere in the app.
//
// The panel is rendered via a portal to document.body and positioned with
// `position: fixed`, rather than being an absolutely-positioned child of
// the "?" button. That's not decorative — a plain absolute child gets
// clipped by any ancestor with overflow:hidden/auto (search-result lists,
// modal bodies, scrollable tables — all common places this component is
// used), and a fixed left:0 offset runs off the right edge of the screen
// whenever the button sits near it. The portal escapes both problems, and
// the position is computed from the button's and panel's real on-screen
// rects so the panel always stays fully within the viewport.

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

const GAP    = 6  // px between the button and the panel
const MARGIN = 8  // px minimum distance from any viewport edge

export function HelpTooltip({ text }: { text: string }) {
  const [open, setOpen]     = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const rootRef  = useRef<HTMLSpanElement | null>(null)
  const btnRef   = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Outside click closes it — "outside" means outside both the button and
  // the portaled panel, which live in different parts of the DOM tree.
  useEffect(() => {
    if (!open) return
    function handleOutsideClick(e: MouseEvent) {
      const target = e.target as Node
      const insideButton = rootRef.current?.contains(target)
      const insidePanel  = panelRef.current?.contains(target)
      if (!insideButton && !insidePanel) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [open])

  // Closing on scroll (rather than continuously repositioning) keeps this
  // simple and avoids the panel drifting away from the button it explains.
  useEffect(() => {
    if (!open) return
    function close() { setOpen(false) }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  useEffect(() => {
    if (!open) setCoords(null)
  }, [open])

  // Position the portaled panel against the button, clamped to stay fully
  // within the viewport. Runs after the (still-invisible) panel has its
  // real measured size, so this works for any text length rather than a
  // guessed height — see the `visibility: hidden` render below.
  useLayoutEffect(() => {
    if (!open || !btnRef.current || !panelRef.current) return
    const btnRect   = btnRef.current.getBoundingClientRect()
    const panelRect = panelRef.current.getBoundingClientRect()

    let left = btnRect.left
    if (left + panelRect.width > window.innerWidth - MARGIN) {
      left = window.innerWidth - panelRect.width - MARGIN
    }
    left = Math.max(MARGIN, left)

    let top = btnRect.bottom + GAP
    if (top + panelRect.height > window.innerHeight - MARGIN) {
      top = btnRect.top - panelRect.height - GAP
    }
    top = Math.max(MARGIN, top)

    setCoords({ top, left })
  }, [open, text])

  return (
    <span className="help-tooltip" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={`help-tooltip-btn ${open ? 'help-tooltip-btn-active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Help"
      >
        ?
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="help-tooltip-panel expand-anim"
          style={{
            position:   'fixed',
            top:        coords?.top ?? 0,
            left:       coords?.left ?? 0,
            visibility: coords ? 'visible' : 'hidden',
          }}
        >
          {text}
        </div>,
        document.body,
      )}
    </span>
  )
}
