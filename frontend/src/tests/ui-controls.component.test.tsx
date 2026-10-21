/**
 * ui-controls.component.test.tsx
 * =================================
 * Component tests for components/ui/controls.tsx (CopyBtn, ThemeToggle,
 * ResetBtn) -- small, bundled presentational components with zero direct
 * component coverage.
 *
 * Coverage
 * --------
 *   CopyBtn: shows the tick only when copiedId matches this button's own
 *     id (not just "something is copied"), click calls onCopy with the
 *     right id, and click does not bubble (stopPropagation)
 *   ThemeToggle: click calls onToggle, label/title/icon all correctly
 *     reflect which mode is CURRENT (so they'd catch an inverted-logic bug)
 *   ResetBtn: click calls onClick, label/title default vs. overridden,
 *     small variant uses smaller icon dimensions
 *
 * Run: npx vitest run src/tests/ui-controls.component.test.tsx
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CopyBtn, ThemeToggle, ResetBtn, NumberField } from '../components/ui/controls'

describe('CopyBtn', () => {
  it('shows the copy icon when this id is not the copied one', () => {
    render(<CopyBtn id="COG0001" copiedId={null} onCopy={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveTextContent('⎘')
  })

  it('shows the checkmark only when copiedId matches this button\'s own id', () => {
    render(<CopyBtn id="COG0001" copiedId="COG0001" onCopy={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveTextContent('✓')
  })

  it('does not show the checkmark when copiedId is a different id', () => {
    render(<CopyBtn id="COG0001" copiedId="COG0002" onCopy={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveTextContent('⎘')
  })

  it('clicking calls onCopy with this button\'s own id', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn()
    render(<CopyBtn id="COG0001" copiedId={null} onCopy={onCopy} />)
    await user.click(screen.getByRole('button'))
    expect(onCopy).toHaveBeenCalledWith('COG0001')
  })

  it('clicking does not bubble up to a parent click handler', async () => {
    const user = userEvent.setup()
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <CopyBtn id="COG0001" copiedId={null} onCopy={vi.fn()} />
      </div>,
    )
    await user.click(screen.getByRole('button'))
    expect(parentClick).not.toHaveBeenCalled()
  })
})

describe('ThemeToggle', () => {
  it('in dark mode, offers to switch to light and shows the Light label', () => {
    render(<ThemeToggle theme="dark" onToggle={vi.fn()} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('title', 'Switch to light mode')
    expect(btn).toHaveTextContent('Light')
  })

  it('in light mode, offers to switch to dark and shows the Dark label', () => {
    render(<ThemeToggle theme="light" onToggle={vi.fn()} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('title', 'Switch to dark mode')
    expect(btn).toHaveTextContent('Dark')
  })

  it('clicking calls onToggle', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<ThemeToggle theme="dark" onToggle={onToggle} />)
    await user.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})

describe('ResetBtn', () => {
  it('uses the default title and label when not overridden', () => {
    render(<ResetBtn onClick={vi.fn()} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('title', 'Reset all page states')
    expect(btn).toHaveTextContent('Reset')
  })

  it('uses a custom title and label when provided', () => {
    render(<ResetBtn onClick={vi.fn()} title="Reset filters" label="Clear" />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('title', 'Reset filters')
    expect(btn).toHaveTextContent('Clear')
  })

  it('clicking calls onClick', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<ResetBtn onClick={onClick} />)
    await user.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('the small variant renders a smaller icon and an sm class', () => {
    const { container: normalContainer } = render(<ResetBtn onClick={vi.fn()} />)
    const normalSvg = normalContainer.querySelector('svg')!
    expect(normalSvg.getAttribute('width')).toBe('15')

    const { container: smallContainer } = render(<ResetBtn onClick={vi.fn()} small />)
    const smallSvg = smallContainer.querySelector('svg')!
    expect(smallSvg.getAttribute('width')).toBe('12')
    expect(smallContainer.querySelector('button')?.className).toContain('sm')
  })
})

describe('NumberField — typing is free, limits apply when you finish', () => {
  function Harness({ initial = 25 }: { initial?: number }) {
    const [v, setV] = React.useState(initial)
    return (
      <>
        <NumberField value={v} min={5} max={200} onChange={setV} aria-label="Top N" />
        <span data-testid="committed">{v}</span>
      </>
    )
  }

  it('typing "12" over the old value gives 12', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const box = screen.getByRole('spinbutton', { name: 'Top N' })
    await user.clear(box)
    await user.type(box, '12')
    await user.tab()
    expect(box).toHaveValue(12)
    expect(screen.getByTestId('committed')).toHaveTextContent('12')
  })

  it('a value outside the limits is clamped when you leave the box', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const box = screen.getByRole('spinbutton', { name: 'Top N' })
    await user.clear(box)
    await user.type(box, '999{Enter}')
    expect(box).toHaveValue(200)
    expect(screen.getByTestId('committed')).toHaveTextContent('200')
    await user.clear(box)
    await user.type(box, '2')
    await user.tab()
    expect(box).toHaveValue(5)
  })

  it('an empty box goes back to the last value', async () => {
    const user = userEvent.setup()
    render(<Harness initial={40} />)
    const box = screen.getByRole('spinbutton', { name: 'Top N' })
    await user.clear(box)
    await user.tab()
    expect(box).toHaveValue(40)
  })
})
