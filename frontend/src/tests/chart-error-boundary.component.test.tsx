/**
 * chart-error-boundary.component.test.tsx
 * ==========================================
 * Component tests for ChartErrorBoundary (components/ui/ChartErrorBoundary.tsx)
 * -- found with its actual error-catching path (getDerivedStateFromError)
 * never exercised: every incidental render elsewhere in the suite only
 * ever hit the "no error" pass-through branch. A safety-net component
 * whose safety net was never actually triggered isn't meaningfully tested.
 *
 * Coverage
 * --------
 *   renders children normally when nothing throws
 *   catches a real thrown error and displays the real error message, not
 *     a canned string
 *   includes the optional `label` prop in the fallback when provided,
 *     omits it when not
 *
 * Run: npx vitest run src/tests/chart-error-boundary.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { ChartErrorBoundary } from '../components/ui/ChartErrorBoundary'

function Bomb({ message }: { message: string }): never {
  throw new Error(message)
}

describe('ChartErrorBoundary — no error', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <ChartErrorBoundary>
        <div>real chart content</div>
      </ChartErrorBoundary>,
    )
    expect(screen.getByText('real chart content')).toBeInTheDocument()
  })
})

describe('ChartErrorBoundary — catches a real render error', () => {
  // React logs the caught error to the console by default; silence it so
  // the expected-and-handled error doesn't look like a real test failure.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the real thrown error message, not a generic fallback string', () => {
    render(
      <ChartErrorBoundary>
        <Bomb message="LOWESS bandwidth out of range" />
      </ChartErrorBoundary>,
    )
    expect(screen.getByText(/Chart failed to render/i)).toBeInTheDocument()
    expect(screen.getByText('LOWESS bandwidth out of range')).toBeInTheDocument()
  })

  it('includes the label in the fallback message when provided', () => {
    render(
      <ChartErrorBoundary label="K00844">
        <Bomb message="boom" />
      </ChartErrorBoundary>,
    )
    expect(screen.getByText(/\(K00844\)/)).toBeInTheDocument()
  })

  it('omits the parenthesized label segment entirely when not provided', () => {
    render(
      <ChartErrorBoundary>
        <Bomb message="boom" />
      </ChartErrorBoundary>,
    )
    expect(screen.queryByText(/\(.*\)/)).not.toBeInTheDocument()
  })
})
