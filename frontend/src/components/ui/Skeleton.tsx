// ── Skeleton ───────────────────────────────────────────────────────────────
// Shimmering placeholder shapes shown while async content loads, instead of
// a bare "Loading…" text box. Base primitive (a single shimmering bar) plus
// composed variants matching the three content shapes used across the app:
// tables, charts, and stat-tile strips.
//
// aria-hidden on every variant — these are decorative; the real "loading"
// state is still communicated via the surrounding status text/DOM state,
// same as before this component existed.

import React from 'react'

export function Skeleton({
  width  = '100%',
  height = 14,
  radius = 4,
  style,
}: {
  width?:  string | number
  height?: string | number
  radius?: number
  style?:  React.CSSProperties
}) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  )
}

// ── SkeletonTable ────────────────────────────────────────────────────────
// Header row + N body rows, each with `columns` shimmering cells. Row widths
// vary deterministically (not random) so re-renders don't jitter and tests
// stay stable.

export function SkeletonTable({
  columns = 5,
  rows    = 6,
}: {
  columns?: number
  rows?:    number
}) {
  const gridTemplateColumns = `repeat(${columns}, 1fr)`
  return (
    <div className="skeleton-table" aria-hidden="true">
      <div className="skeleton-table-row skeleton-table-header" style={{ gridTemplateColumns }}>
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} height={9} width="55%" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="skeleton-table-row" style={{ gridTemplateColumns }}>
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} height={11} width={`${45 + ((r * 7 + c * 13) % 40)}%`} />
          ))}
        </div>
      ))}
    </div>
  )
}

// ── SkeletonChart ────────────────────────────────────────────────────────
// A plot-area rectangle plus a handful of y-axis tick placeholders, roughly
// matching EgcChart's proportions (default height 320 matches its own
// `layout.height`).

export function SkeletonChart({ height = 320 }: { height?: number }) {
  return (
    <div className="skeleton-chart" style={{ height }} aria-hidden="true">
      <div className="skeleton-chart-yaxis">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} height={8} width={28} />
        ))}
      </div>
      <div className="skeleton-chart-plot">
        <Skeleton height="100%" width="100%" radius={6} />
      </div>
    </div>
  )
}

// ── SkeletonStatTiles ────────────────────────────────────────────────────
// A row of N stat tiles (value + label), matching the shape of
// .scaffold-stat / the Analyze quick-stats strip.

export function SkeletonStatTiles({ count = 4 }: { count?: number }) {
  return (
    <div className="skeleton-stat-tiles" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton-stat-tile">
          <Skeleton height={18} width={36} radius={4} />
          <Skeleton height={8} width={44} radius={3} />
        </div>
      ))}
    </div>
  )
}

// ── SkeletonTreeRows ─────────────────────────────────────────────────────
// A short list of chevron + label rows, matching .tax-node-row's shape
// (TaxonomyTree / TaxonomyBrowseTree).

export function SkeletonTreeRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-tree" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-tree-row">
          <Skeleton height={10} width={10} radius={2} />
          <Skeleton height={10} width={`${60 - i * 6}%`} />
        </div>
      ))}
    </div>
  )
}
