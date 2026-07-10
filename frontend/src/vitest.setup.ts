/**
 * vitest.setup.ts
 * ===============
 * Loaded before every test file via vite.config.ts `setupFiles`.
 *
 * Responsibilities
 * ----------------
 * 1. Load @testing-library/jest-dom so `expect(el).toBeInTheDocument()` etc. work.
 * 2. Polyfill jsdom gaps that the component and logic tests rely on:
 *    - URL.createObjectURL / revokeObjectURL  (used by downloadCsv)
 *    - navigator.clipboard.writeText         (used by CopyBtn, KEGG Color Mapper)
 *    - window.open                           (used by external link helpers)
 *    - ResizeObserver                         (required by Plotly useResizeHandler)
 *
 * None of these are implemented by jsdom; without stubs every component test
 * that touches a download, copy, or chart throws before any assertion runs.
 */

import '@testing-library/jest-dom'
import { vi } from 'vitest'

// ── URL blob helpers ───────────────────────────────────────────────────────
// Root cause of "TypeError: URL is not a constructor" — jsdom ships a partial
// URL implementation that omits the static blob methods entirely.

if (typeof URL.createObjectURL === 'undefined') {
  URL.createObjectURL = (_blob: Blob): string => 'blob:mock-url'
}
if (typeof URL.revokeObjectURL === 'undefined') {
  URL.revokeObjectURL = (_url: string): void => {}
}

// ── Clipboard API ──────────────────────────────────────────────────────────
// navigator.clipboard is undefined in jsdom. CopyBtn and the KEGG Color
// Mapper button both call navigator.clipboard.writeText().

Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText:  vi.fn().mockResolvedValue(''),
  },
  writable: true,
  configurable: true,
})

// ── window.open ────────────────────────────────────────────────────────────
// External links and KEGG Color Mapper call window.open(url, '_blank').
// jsdom throws; replace with a no-op spy.

vi.stubGlobal('open', vi.fn())

// ── ResizeObserver ─────────────────────────────────────────────────────────
// Plotly's useResizeHandler (and jsdom in general) requires ResizeObserver.
// jsdom does not implement it; without a stub every chart render throws.

if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe()   {}
    unobserve() {}
    disconnect() {}
  }
}

// ── fetch ──────────────────────────────────────────────────────────────────
// Component tests that mount the full App will trigger API calls.
// Return a sensible offline response so the API-status indicator renders
// the "offline" state instead of hanging.

if (typeof globalThis.fetch === 'undefined' || !(globalThis.fetch as unknown as { _isMock?: boolean })._isMock) {
  const mockFetch = vi.fn().mockRejectedValue(new Error('Network unavailable in test environment'))
  ;(mockFetch as unknown as { _isMock: boolean })._isMock = true
  vi.stubGlobal('fetch', mockFetch)
}