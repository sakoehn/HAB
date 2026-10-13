/**
 * date-range-picker.component.test.tsx
 * =======================================
 * Component tests for DateRangePicker (components/ui/DateRangePicker.tsx).
 * Previously had no dedicated tests of its own (only a thin "2 inputs
 * render" smoke test buried in analyze-page.component.test.tsx).
 *
 * Coverage
 * --------
 *   renders from/to date inputs with the dataset min/max
 *   clear button shown only when a date is set
 *   G14 (docs/AUDIT-2026-10-05.md): each input's min/max is also
 *     constrained by the OTHER input's current value, not just the
 *     dataset's own range -- prevents ever selecting an inverted range
 *     via the native date picker, which silently emptied every chart/
 *     table reading it with no error shown
 *
 * Run: npx vitest run src/tests/date-range-picker.component.test.tsx
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { DateRangePicker } from '../components/ui/DateRangePicker'

function getInputs() {
  const inputs = document.querySelectorAll('input[type="date"]')
  return { fromInput: inputs[0] as HTMLInputElement, toInput: inputs[1] as HTMLInputElement }
}

describe('DateRangePicker — rendering', () => {
  it('renders two date inputs bounded by the dataset min/max when neither side is set', () => {
    render(
      <DateRangePicker
        from="" to=""
        onFrom={vi.fn()} onTo={vi.fn()} onClear={vi.fn()}
        minDate="2021-05-27" maxDate="2021-06-17"
      />,
    )
    const { fromInput, toInput } = getInputs()
    expect(fromInput.min).toBe('2021-05-27')
    expect(fromInput.max).toBe('2021-06-17')
    expect(toInput.min).toBe('2021-05-27')
    expect(toInput.max).toBe('2021-06-17')
  })

  it('does not show the clear button when no date is set', () => {
    render(<DateRangePicker from="" to="" onFrom={vi.fn()} onTo={vi.fn()} onClear={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument()
  })

  it('shows the clear button once a date is set', () => {
    render(<DateRangePicker from="2021-06-01" to="" onFrom={vi.fn()} onTo={vi.fn()} onClear={vi.fn()} />)
    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument()
  })
})

// G14 (docs/AUDIT-2026-10-05.md): an inverted range (from after to, or to
// before from) silently emptied every chart/table reading it, with no
// error shown anywhere -- each input only enforced the dataset's own
// overall min/max, never the other input's current selection.
describe('DateRangePicker — from/to cross-constraint (G14)', () => {
  it("caps the FROM input's max at the already-selected TO date, not just the dataset max", () => {
    render(
      <DateRangePicker
        from="" to="2021-06-01"
        onFrom={vi.fn()} onTo={vi.fn()} onClear={vi.fn()}
        minDate="2021-05-27" maxDate="2021-06-17"
      />,
    )
    const { fromInput } = getInputs()
    // Must be the narrower bound (the selected `to`), not the dataset's
    // own wider max -- otherwise the native picker still lets the user
    // pick a `from` after `to`.
    expect(fromInput.max).toBe('2021-06-01')
  })

  it("floors the TO input's min at the already-selected FROM date, not just the dataset min", () => {
    render(
      <DateRangePicker
        from="2021-06-01" to=""
        onFrom={vi.fn()} onTo={vi.fn()} onClear={vi.fn()}
        minDate="2021-05-27" maxDate="2021-06-17"
      />,
    )
    const { toInput } = getInputs()
    expect(toInput.min).toBe('2021-06-01')
  })

  it('falls back to the dataset min/max on the unconstrained side when the other input is empty', () => {
    render(
      <DateRangePicker
        from="" to=""
        onFrom={vi.fn()} onTo={vi.fn()} onClear={vi.fn()}
        minDate="2021-05-27" maxDate="2021-06-17"
      />,
    )
    const { fromInput, toInput } = getInputs()
    expect(fromInput.max).toBe('2021-06-17')
    expect(toInput.min).toBe('2021-05-27')
  })
})
