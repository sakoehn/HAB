// ── MappingsExportBox ─────────────────────────────────────────────────────────
// "Export all" for the Mappings panel: every gene record for one annotation,
// optionally limited to a date range, as a CSV streamed from
// /api/mappings/export. The size comes first from /api/mappings/export/summary
// so the user knows what they're getting:
//   - up to MAPPINGS_EXPORT_CONFIRM_ROWS: a plain download link
//   - above that: a confirmation naming the size, the wait and Excel's limit
//   - above the server's max_rows: no download, only a way to narrow it
// The download is a plain link, so the browser writes the file to disk as it
// arrives instead of the page holding it in memory.

import { useEffect, useState } from 'react'

import type { ApiStatus } from '../../types'
import { apiFetch } from '../../utils/api'
import { isoDate } from '../../utils/format'
import { useAllSamples } from '../../utils/useAllSamples'
import { DateRangePicker } from '../ui/DateRangePicker'
import {
  buildMappingsExportQuery, estimateExportSize,
  MAPPINGS_EXPORT_CONFIRM_ROWS, type MappingsExportSummary,
} from './mappingsData'

export function MappingsExportBox({
  annotationId,
  source,
  uniquePairs,
}: {
  annotationId: string
  source:       string
  uniquePairs:  boolean
}) {
  const { allSamples } = useAllSamples()
  const minDate = allSamples?.length ? isoDate(allSamples[0].datetime) : undefined
  const maxDate = allSamples?.length ? isoDate(allSamples[allSamples.length - 1].datetime) : undefined

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  // Each answer is kept with the query it answers, so a new date range
  // reads as loading until its own answer arrives, and a confirmation
  // given for one range doesn't carry over to another.
  const [summaryResult, setSummaryResult] = useState<{
    query: string; summary: MappingsExportSummary | null; status: ApiStatus
  } | null>(null)
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null)

  const query = buildMappingsExportQuery(annotationId, source, dateFrom, dateTo)
  const href  = `/api/mappings/export?${query}&unique_pairs=${uniquePairs}`

  useEffect(() => {
    let cancelled = false
    apiFetch<MappingsExportSummary>(`/api/mappings/export/summary?${query}`)
      .then(s => { if (!cancelled) setSummaryResult({ query, summary: s, status: 'ok' }) })
      .catch(() => { if (!cancelled) setSummaryResult({ query, summary: null, status: 'error' }) })
    return () => { cancelled = true }
  }, [query])

  const status: ApiStatus = summaryResult?.query === query ? summaryResult.status : 'loading'
  const summary = status === 'ok' ? summaryResult!.summary : null
  const confirming = confirmedFor === query
  const setConfirming = (on: boolean) => setConfirmedFor(on ? query : null)

  const rows = summary?.rows ?? 0
  const tooBig = status === 'ok' && summary != null && rows > summary.max_rows
  const size = estimateExportSize(rows)

  return (
    <div
      data-testid="mappings-export"
      className="state-box"
      style={{ display: 'block', padding: '10px 12px', margin: '0 0 10px', textAlign: 'left' }}
    >
      <DateRangePicker
        from={dateFrom}
        to={dateTo}
        onFrom={setDateFrom}
        onTo={setDateTo}
        onClear={() => { setDateFrom(''); setDateTo('') }}
        minDate={minDate}
        maxDate={maxDate}
      />

      <div style={{ font: '12px var(--sans)', marginTop: 8 }}>
        {status === 'loading' && <span style={{ color: 'var(--text-dim)' }}>Working out the size of this export…</span>}
        {status === 'error' && <span>Could not work out the size of this export. Try again.</span>}
        {status === 'ok' && rows === 0 && <span>No gene records for {annotationId} in this date range.</span>}

        {tooBig && summary && (
          <span data-testid="mappings-export-too-big">
            {rows.toLocaleString()} gene records ({size}) is over the {summary.max_rows.toLocaleString()}-row
            limit for one export. Narrow the date range above, or use Explore → Bulk Download for
            per-sample totals instead of individual genes.
          </span>
        )}

        {status === 'ok' && rows > 0 && !tooBig && summary && (
          <>
            <div data-testid="mappings-export-size" style={{ marginBottom: 8 }}>
              {rows.toLocaleString()} gene records across {summary.samples} samples · about {size}
              {uniquePairs && ' (fewer with "Unique pairs only")'}
            </div>
            {rows <= MAPPINGS_EXPORT_CONFIRM_ROWS ? (
              <a className="btn sm primary" style={{ textDecoration: 'none' }} href={href} download>
                ↓ Download CSV
              </a>
            ) : !confirming ? (
              <button className="btn sm primary" onClick={() => setConfirming(true)}>↓ Download CSV</button>
            ) : (
              <div data-testid="mappings-export-confirm" style={{ color: 'var(--amber)' }}>
                ⚠ This is a large file: {rows.toLocaleString()} rows, about {size}. It can take a long time
                to download (the largest exports can take over an hour), and Excel can't open files over
                1,048,576 rows, so plan to open it with R, Python or a database.
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <a className="btn sm primary" style={{ textDecoration: 'none' }} href={href} download>
                    ↓ Download anyway
                  </a>
                  <button className="btn sm ghost" onClick={() => setConfirming(false)}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
