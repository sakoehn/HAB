// ── DateRangePicker ───────────────────────────────────────────────────────────
// Two date inputs (from / to) with a clear button.
// Used in chart cards, the compare drawer, and explore panels.
//
// minDate / maxDate constrain the browser date picker to the actual data range
// returned by /api/status (date_min, date_max).  Always pass these when
// available so users cannot select dates outside the dataset.
//
// Usage:
//   <DateRangePicker
//     from={dateFrom} to={dateTo}
//     onFrom={setDateFrom} onTo={setDateTo}
//     onClear={() => { setDateFrom(''); setDateTo('') }}
//     minDate={dataDateRange?.min}
//     maxDate={dataDateRange?.max}
//   />

import React from 'react'

export function DateRangePicker({
  from,
  to,
  onFrom,
  onTo,
  onClear,
  minDate,
  maxDate,
}: {
  from:     string
  to:       string
  onFrom:   (v: string) => void
  onTo:     (v: string) => void
  onClear:  () => void
  minDate?: string
  maxDate?: string
}) {
  const active = from || to

  return (
    <div className="date-range">
      <span className="date-range-label">Date range:</span>
      <input
        type="date"
        className="field date-field"
        value={from}
        min={minDate}
        // Also capped at `to` (when set),
        // not just the dataset's own max -- without this, picking a
        // `from` after the already-selected `to` silently produces an
        // inverted range that empties every chart/table reading it, with
        // no error shown anywhere.
        max={to || maxDate}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onFrom(e.target.value)}
      />
      <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>→</span>
      <input
        type="date"
        className="field date-field"
        value={to}
        // Also floored at `from` (when set), for the same reason as `max`
        // above, mirrored.
        min={from || minDate}
        max={maxDate}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onTo(e.target.value)}
      />
      {active && (
        <button className="btn ghost sm" onClick={onClear}>
          ✕ clear
        </button>
      )}
    </div>
  )
}
