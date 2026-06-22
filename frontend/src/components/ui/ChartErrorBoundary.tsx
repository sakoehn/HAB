// ── ChartErrorBoundary ────────────────────────────────────────────────────────
// React error boundary that wraps each chart card.
// Catches render errors in chart children and shows a contained error message
// rather than crashing the entire page.
//
// Must be a class component — React does not support error boundaries as
// function components (getDerivedStateFromError / componentDidCatch are
// class-only lifecycle methods).
//
// Usage:
//   <ChartErrorBoundary label="K02014">
//     <EgcChart ... />
//   </ChartErrorBoundary>

import React from 'react'

type Props = {
  children: React.ReactNode
  label?:   string
}

type State = {
  hasError: boolean
  message:  string
}

export class ChartErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, message: '' }
  }

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="state-box error"
          style={{ padding: '20px', borderRadius: 8 }}
        >
          <div className="state-icon">⚠</div>
          <span>
            Chart failed to render
            {this.props.label ? ` (${this.props.label})` : ''}.{' '}
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize:   11,
                color:      'var(--text-dim)',
              }}
            >
              {this.state.message}
            </span>
          </span>
        </div>
      )
    }

    return this.props.children
  }
}
