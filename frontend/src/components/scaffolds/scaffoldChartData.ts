// Chart rows for Scaffold Explore: per-term rows filtered to the chosen
// samples, and per-sample sums across terms. Kept apart from
// ScaffoldExplorePanel so that file exports only components.

import type { ScaffoldSummaryRow } from '../../types'
import { isoDate, parseDateTime } from '../../utils/format'

export type AggregatedChartRow = { date: string; scaffold_count: number; gene_count: number }

// Filters a term's scaffold summary rows to a date range and sorts
// chronologically — used by the per-term "View chart" toggle, and by
// chartSeries below for the split-by-term case.
//
// dateFrom/dateTo are bare "YYYY-MM-DD" from <input type="date">, while
// r.date is the raw datetime the scaffold summary endpoint returns (unpadded
// "M/D/YY H:MM", e.g. "5/27/21 13:00" — see FastAPI/api/index.py's
// _parse_any_datetime docstring). Comparing them as plain text is wrong --
// different formats entirely, so a date_to would empty everything and a
// date_from would filter nothing. isoDate() normalizes r.date to the same
// "YYYY-MM-DD" shape first.
export function filterSummaryForChart(
  rows:     ScaffoldSummaryRow[],
  dateFrom: string,
  dateTo:   string,
): ScaffoldSummaryRow[] {
  return rows
    .filter(r => {
      const iso = isoDate(r.date)
      if (dateFrom && iso < dateFrom) return false
      if (dateTo   && iso > dateTo)   return false
      return true
    })
    .sort((a, b) => parseDateTime(a.date) - parseDateTime(b.date))
}

// Sums scaffold_count/gene_count across every term's rows, per date, within
// a date range — the "aggregated" (non-split) chart mode. Same date-range
// handling as filterSummaryForChart, see its docstring for why raw text
// comparison is wrong here.
export function buildAggregatedChartRows(
  terms:    { summary: ScaffoldSummaryRow[] }[],
  dateFrom: string,
  dateTo:   string,
): AggregatedChartRow[] {
  const dateMap: Record<string, AggregatedChartRow> = {}
  for (const term of terms) {
    for (const row of term.summary) {
      const iso = isoDate(row.date)
      if (dateFrom && iso < dateFrom) continue
      if (dateTo   && iso > dateTo)   continue
      if (!dateMap[row.date]) {
        dateMap[row.date] = { scaffold_count: 0, gene_count: 0, date: row.date }
      }
      dateMap[row.date].scaffold_count += row.scaffold_count
      dateMap[row.date].gene_count     += row.gene_count
    }
  }
  return Object.values(dateMap).sort((a, b) => parseDateTime(a.date) - parseDateTime(b.date))
}
