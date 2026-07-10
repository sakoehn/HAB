/**
 * help-tooltip.component.test.tsx
 * =================================
 * Component tests for the shared HelpTooltip "?" click-to-reveal badge.
 *
 * Generalizes the existing click-to-reveal pattern from
 * AnnotationInfoDrawer.tsx (the only reusable info-bubble already in the
 * codebase) into a small presentational component used to explain
 * non-obvious controls throughout the app.
 *
 * Coverage
 * --------
 *   panel hidden initially
 *   clicking "?" reveals the panel with the given text
 *   clicking "?" again hides the panel
 *   clicking outside the tooltip closes it
 *   clicking inside the open panel does not close it
 *
 * Positioning (panel is portaled to document.body — see HelpTooltip.tsx):
 *   positions below-left of the button when there's room
 *   clamps to the right edge of the viewport instead of overflowing off-screen
 *   flips above the button when there's no room below
 *   closes on scroll instead of drifting away from its button
 *
 * Run: npx vitest run src/tests/help-tooltip.component.test.tsx
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { HelpTooltip } from '../components/ui/HelpTooltip'

// jsdom has no real layout engine — getBoundingClientRect always returns
// zeros unless mocked. These helpers fake just enough of a layout to
// exercise the viewport-boundary logic.
function rect(overrides: Partial<DOMRect>): DOMRect {
  return {
    top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON() { return this },
    ...overrides,
  } as DOMRect
}

function mockRects(btnRect: Partial<DOMRect>, panelRect: Partial<DOMRect>) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this.tagName === 'BUTTON') return rect(btnRect)
    if (this.classList.contains('help-tooltip-panel')) return rect(panelRect)
    return rect({})
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HelpTooltip', () => {
  it('panel is not shown initially', () => {
    render(<HelpTooltip text="Explains the thing" />)
    expect(screen.queryByText('Explains the thing')).toBeNull()
  })

  it('clicking "?" reveals the panel with the given text', async () => {
    render(<HelpTooltip text="Explains the thing" />)
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() => {
      expect(screen.getByText('Explains the thing')).toBeInTheDocument()
    })
  })

  it('clicking "?" again hides the panel', async () => {
    render(<HelpTooltip text="Explains the thing" />)
    const btn = screen.getByRole('button')
    await userEvent.click(btn)
    await waitFor(() => expect(screen.getByText('Explains the thing')).toBeInTheDocument())
    await userEvent.click(btn)
    await waitFor(() => expect(screen.queryByText('Explains the thing')).toBeNull())
  })

  it('clicking outside the tooltip closes it', async () => {
    render(
      <div>
        <HelpTooltip text="Explains the thing" />
        <div data-testid="outside">Somewhere else</div>
      </div>,
    )
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByText('Explains the thing')).toBeInTheDocument())
    await userEvent.click(screen.getByTestId('outside'))
    await waitFor(() => expect(screen.queryByText('Explains the thing')).toBeNull())
  })

  it('clicking inside the open panel does not close it', async () => {
    render(<HelpTooltip text="Explains the thing" />)
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByText('Explains the thing')).toBeInTheDocument())
    await userEvent.click(screen.getByText('Explains the thing'))
    expect(screen.getByText('Explains the thing')).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Positioning — panel is portaled to document.body so it can never be
// clipped by an ancestor's overflow:hidden/auto, and is placed to stay
// fully within the viewport.
// ─────────────────────────────────────────────────────────────────────────────

describe('HelpTooltip — positioning', () => {
  it('positions below-left of the button when there is room', async () => {
    Object.defineProperty(window, 'innerWidth',  { value: 1024, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 768,  configurable: true })
    mockRects(
      { left: 100, top: 34, bottom: 50, right: 116, width: 16, height: 16 },
      { width: 200, height: 60 },
    )
    render(<HelpTooltip text="Explains the thing" />)
    await userEvent.click(screen.getByRole('button'))

    const panel = await waitFor(() => document.querySelector('.help-tooltip-panel') as HTMLElement)
    expect(panel.style.left).toBe('100px')
    expect(panel.style.top).toBe('56px') // btnRect.bottom (50) + 6px gap
  })

  it('clamps to the right edge instead of overflowing off-screen', async () => {
    Object.defineProperty(window, 'innerWidth',  { value: 1024, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 768,  configurable: true })
    // Button near the right edge: 950 + 280 (panel width) would overflow past 1024.
    mockRects(
      { left: 950, top: 34, bottom: 50, right: 966, width: 16, height: 16 },
      { width: 280, height: 60 },
    )
    render(<HelpTooltip text="Explains the thing" />)
    await userEvent.click(screen.getByRole('button'))

    const panel = await waitFor(() => document.querySelector('.help-tooltip-panel') as HTMLElement)
    const left  = parseFloat(panel.style.left)
    expect(left + 280).toBeLessThanOrEqual(1024)
    expect(left).toBeGreaterThan(0)
  })

  it('flips above the button when there is no room below', async () => {
    Object.defineProperty(window, 'innerWidth',  { value: 1024, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 768,  configurable: true })
    // Button near the bottom: 750 + 6 + 100 (panel height) would overflow past 768.
    mockRects(
      { left: 100, top: 734, bottom: 750, right: 116, width: 16, height: 16 },
      { width: 200, height: 100 },
    )
    render(<HelpTooltip text="Explains the thing" />)
    await userEvent.click(screen.getByRole('button'))

    const panel = await waitFor(() => document.querySelector('.help-tooltip-panel') as HTMLElement)
    const top   = parseFloat(panel.style.top)
    expect(top).toBeLessThan(734) // above the button, not below it
  })

  it('closes on scroll instead of drifting away from its button', async () => {
    mockRects(
      { left: 100, top: 34, bottom: 50, right: 116, width: 16, height: 16 },
      { width: 200, height: 60 },
    )
    render(<HelpTooltip text="Explains the thing" />)
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByText('Explains the thing')).toBeInTheDocument())

    window.dispatchEvent(new Event('scroll'))

    await waitFor(() => {
      expect(screen.queryByText('Explains the thing')).toBeNull()
    })
  })
})
