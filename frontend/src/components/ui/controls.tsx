// ── UI Controls ───────────────────────────────────────────────────────────────
// Small presentational components with no page-level state dependencies.
// Bundled together because each is under 25 lines.
//
// Exports:
//   CopyBtn      — clipboard copy button with ✓ feedback tick
//   ThemeToggle  — dark/light mode toggle button
//   ResetBtn     — reset all page state button

import React from 'react'
import type { Theme } from '../../types'

// ── CopyBtn ────────────────────────────────────────────────────────────────
// Renders a small ⎘ button that copies an annotation ID to the clipboard.
// Shows ✓ for 1.5 seconds after copying (controlled by the useCopyId hook
// in the parent — this component is purely presentational).

export function CopyBtn({
  id,
  copiedId,
  onCopy,
}: {
  id:       string
  copiedId: string | null
  onCopy:   (id: string) => void
}) {
  const copied = copiedId === id
  return (
    <button
      className="copy-btn"
      title="Copy annotation ID"
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation()
        onCopy(id)
      }}
    >
      {copied ? '✓' : '⎘'}
    </button>
  )
}

// ── ThemeToggle ────────────────────────────────────────────────────────────
// Sun/moon toggle button in the topbar.

export function ThemeToggle({
  theme,
  onToggle,
}: {
  theme:    Theme
  onToggle: () => void
}) {
  return (
    <button
      className="theme-toggle"
      onClick={onToggle}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
          <path
            fillRule="evenodd"
            d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
      )}
      <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
    </button>
  )
}

// ── ResetBtn ───────────────────────────────────────────────────────────────
// Rotating arrow button that resets all page state.

export function ResetBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="refresh-btn"
      onClick={onClick}
      title="Reset all page states"
    >
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        width="15"
        height="15"
      >
        <path d="M4 4v5h5M16 16v-5h-5" />
        <path d="M4 9a7 7 0 0 1 12.9-2.7M16 11a7 7 0 0 1-12.9 2.7" />
      </svg>
      <span>Reset</span>
    </button>
  )
}
