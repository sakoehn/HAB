/**
 * vitest.setup.ts
 * ===============
 * Place at: frontend/src/vitest.setup.ts
 */

import '@testing-library/jest-dom'
import { vi } from 'vitest'

// ── Fix jsdom's broken URL class ───────────────────────────────────────────
// jsdom ships a URL implementation that throws "URL is not a constructor"
// when code does `new URL(...)`. Replace it wholesale with Node's built-in
// URL which is fully spec-compliant. This must happen before any test file
// imports App.tsx, which is why it's at the top of the setup file.

import { URL as NodeURL, URLSearchParams as NodeURLSearchParams } from 'url'
globalThis.URL            = NodeURL as unknown as typeof URL
globalThis.URLSearchParams = NodeURLSearchParams as unknown as typeof URLSearchParams

// ── URL blob helpers ───────────────────────────────────────────────────────
// Node's URL doesn't have createObjectURL either — stub those separately.

URL.createObjectURL = (_blob: Blob): string => 'blob:mock-url'
URL.revokeObjectURL = (_url: string): void => {}

// ── Canvas context ─────────────────────────────────────────────────────────

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function () {
    return {
      scale:     vi.fn(),
      fillRect:  vi.fn(),
      fillText:  vi.fn(),
      drawImage: vi.fn(),
      fillStyle: '',
      font:      '',
      textAlign: 'left' as CanvasTextAlign,
    }
  } as unknown as typeof HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.toDataURL = (): string =>
    'data:image/png;base64,mock'
}

// ── Clipboard API ──────────────────────────────────────────────────────────

Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText:  vi.fn().mockResolvedValue(''),
  },
  writable:     true,
  configurable: true,
})

// ── window.open ────────────────────────────────────────────────────────────

vi.stubGlobal('open', vi.fn())

// ── ResizeObserver ─────────────────────────────────────────────────────────

if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe()    {}
    unobserve()  {}
    disconnect() {}
  }
}

// ── fetch ──────────────────────────────────────────────────────────────────
// Reject all API calls so the app renders in "offline" state.

vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
  new Error('Network unavailable in test environment')
))