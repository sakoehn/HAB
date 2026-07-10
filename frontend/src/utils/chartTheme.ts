// ── chartTheme ────────────────────────────────────────────────────────────────
// Shared Plotly style constants used across all chart components, so every
// chart's hover tooltip looks the same regardless of which one renders it.

import type { ChartMetric } from '../types'

export const PLOTLY_HOVERLABEL = {
  bgcolor: 'rgba(15,15,25,0.82)',
  bordercolor: 'rgba(255,255,255,0.15)',
  font: { size: 11, color: '#e8e8f0', family: 'monospace' },
  align: 'left' as const,
  namelength: 0,
}

// EgcChart's y-axis label for the current metric/standardize combination.
export function getEgcYLabel(metric: ChartMetric, standardize: boolean): string {
  return metric === 'norm_egc'
    ? (standardize ? 'Relative Abundance (Z-score, σ from mean)' : 'Relative Abundance')
    : (standardize ? 'EGC (Z-score, σ from mean)' : 'EGC')
}

// EgcChart's hover-tooltip label for the current metric/standardize combination.
export function getEgcHoverYLabel(metric: ChartMetric, standardize: boolean): string {
  return metric === 'norm_egc'
    ? (standardize ? 'Rel. Abund. Z-Score' : 'Rel. Abundance')
    : (standardize ? 'Z-Score' : 'EGC')
}
