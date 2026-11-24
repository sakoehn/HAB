// ── BulkByTaxonSection ────────────────────────────────────────────────────────
// The Bulk Download section's "KEGG by taxon" form: paste KO ids, pick a
// rank to group taxa at and a file format, and download each KO's EGC split
// by the taxa its genes belong to, per timepoint. The size comes from
// /api/series/export/by-taxon/summary (re-asked shortly after typing
// stops); the file from /api/series/export/by-taxon as a text/plain form
// post, so a long KO list never has to fit in a link and the browser
// streams the file to disk.

import React, { useEffect, useState } from 'react'

import type { ApiStatus } from '../../types'
import {
  buildByTaxonQuery, koSelectionJson, parseKoList, rankOptionsBelow,
  type ByTaxonFormat, type ByTaxonMetric,
} from '../../utils/bulkDownload'
import { DateRangePicker } from '../ui/DateRangePicker'
import { HelpTooltip } from '../ui/HelpTooltip'

type ByTaxonSummary = {
  kos:         number
  unknown_kos: string[]
  rank:        string
  samples:     number
  genes:       number
  max_genes:   number
}

// How long typing must pause before the size is asked for again.
const TYPING_PAUSE_MS = 300

const RANKS = rankOptionsBelow(null)

const SHARED_HELP =
  ' A taxon is its lineage down to the chosen rank, so taxa with the same name in different lineages are separate rows.' +
  ' "unclassified …" taxa hold the genes that were not classified down to this rank, and "Unclassified" the genes with' +
  ' no taxonomy at all, so each KO\'s rows add up to its own total. norm_egc is egc divided by the sample\'s total over' +
  ' all annotated genes. Each KO\'s taxa are listed largest total EGC first. The name is blank for a KO that JGI gives' +
  ' no name to.'

const COLUMNS_HELP: Record<ByTaxonFormat, string> = {
  long:
    'Columns: ko, ko_name, taxon, rank, lineage, sample, date, time, egc, norm_egc, detected. One row per KO, taxon' +
    ' and timepoint. Timepoints where a taxon had none of the KO\'s genes are written as 0 with detected = false.' +
    SHARED_HELP,
  wide:
    'Columns: ko, ko_name, taxon, rank, lineage, then one column per timepoint (date and time, e.g. 2021-05-27 13:00)' +
    ' holding the chosen value. One row per KO and taxon; 0 where a taxon had none of the KO\'s genes at that' +
    ' timepoint.' + SHARED_HELP,
}

export function BulkByTaxonSection({ dataDateRange }: { dataDateRange?: { min: string; max: string } | null }) {
  const [text, setText]         = useState('')
  const [rank, setRank]         = useState('genus')
  const [format, setFormat]     = useState<ByTaxonFormat>('long')
  const [metric, setMetric]     = useState<ByTaxonMetric>('egc')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')

  const kos = parseKoList(text)
  const kosKey = kos.join(',')

  // The KO list the size is asked for: the typed one, once typing pauses.
  const [askedKos, setAskedKos] = useState<string[]>([])
  useEffect(() => {
    const timer = setTimeout(() => setAskedKos(kosKey ? kosKey.split(',') : []), TYPING_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [kosKey])

  const query = buildByTaxonQuery({ rank, format, metric, dateFrom, dateTo })
  const selection = askedKos.length ? koSelectionJson(askedKos) : ''
  const summaryKey = selection && `${query}#${selection}`

  // The last summary response, with the request it answers -- it only
  // counts while that is still the current choice, so a slower,
  // superseded response is never shown.
  const [summaryResult, setSummaryResult] = useState<
    { key: string; summary: ByTaxonSummary | null; status: 'ok' | 'error' } | null
  >(null)

  useEffect(() => {
    if (!summaryKey) return
    let cancelled = false
    fetch(`/api/series/export/by-taxon/summary?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `selection=${selection}`,
    })
      .then(res => { if (!res.ok) throw new Error(`${res.status}`); return res.json() })
      .then((json: ByTaxonSummary) => {
        if (!cancelled) setSummaryResult({ key: summaryKey, summary: json, status: 'ok' })
      })
      .catch(() => {
        if (!cancelled) setSummaryResult({ key: summaryKey, summary: null, status: 'error' })
      })
    return () => { cancelled = true }
  }, [query, selection, summaryKey])

  const upToDate = kosKey === askedKos.join(',')
  const summaryStatus: ApiStatus = !kosKey
    ? 'idle'
    : upToDate && summaryResult?.key === summaryKey ? summaryResult.status : 'loading'
  const summary = summaryStatus === 'ok' ? summaryResult!.summary : null
  const tooBig = !!summary && summary.genes > summary.max_genes
  const canDownload = !!summary && summary.kos > 0 && summary.samples > 0 && !tooBig

  return (
    <div style={{ padding: '0 24px 24px' }}>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20, marginBottom: 4 }}><h3>KEGG by taxon</h3></div>
      <p style={{ font: '12px var(--sans)', color: 'var(--text-dim)', marginBottom: 16, maxWidth: 760 }}>
        Each KO's EGC split by the taxa its genes belong to, at every timepoint, as a CSV.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '12px 14px', alignItems: 'center', maxWidth: 760 }}>
        <label htmlFor="bytaxon-kos" className="bulk-label" style={{ alignSelf: 'start', paddingTop: 6 }}>KOs</label>
        <div>
          <textarea
            id="bytaxon-kos"
            className="field"
            rows={3}
            style={{ width: '100%', font: '13px var(--mono)', resize: 'vertical' }}
            placeholder="K02014, K00525 …"
            value={text}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
          />
          <div style={{ font: '11px var(--sans)', color: 'var(--text-dim)', marginTop: 4 }}>
            Paste KO ids separated by commas, spaces or new lines.
          </div>
        </div>

        <label htmlFor="bytaxon-rank" className="bulk-label">Group by</label>
        <select
          id="bytaxon-rank"
          className="field"
          style={{ width: 200 }}
          value={rank}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRank(e.target.value)}
        >
          {RANKS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <span className="bulk-label">Format</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', font: '12px var(--sans)', color: 'var(--text)' }}>
          {(['long', 'wide'] as const).map(f => (
            <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" name="bytaxon-format" checked={format === f} onChange={() => setFormat(f)} />
              {f === 'long' ? 'Long' : 'Wide'}
            </label>
          ))}
          {format === 'wide' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label htmlFor="bytaxon-metric" className="bulk-label">Value</label>
              <select
                id="bytaxon-metric"
                className="field"
                value={metric}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setMetric(e.target.value as ByTaxonMetric)}
              >
                <option value="egc">EGC</option>
                <option value="norm_egc">Normalized EGC</option>
              </select>
            </span>
          )}
        </div>

        <span className="bulk-label">Dates</span>
        <DateRangePicker
          from={dateFrom}
          to={dateTo}
          onFrom={setDateFrom}
          onTo={setDateTo}
          onClear={() => { setDateFrom(''); setDateTo('') }}
          minDate={dataDateRange?.min}
          maxDate={dataDateRange?.max}
        />
      </div>

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 14, maxWidth: 760 }}>
        {summaryStatus === 'loading' && (
          <div style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>Counting…</div>
        )}
        {summaryStatus === 'error' && (
          <div data-testid="bytaxon-error" className="state-box error" style={{ padding: 12 }}>
            Could not work out the size of this download. Try again, or check the KO list.
          </div>
        )}
        {summary && (
          <div data-testid="bytaxon-size" style={{ font: '12px var(--mono)', color: 'var(--text-h)' }}>
            {summary.kos === 0
              ? 'None of these KOs are in the data.'
              : summary.samples === 0
                ? 'No samples in this date range.'
                : `${summary.kos.toLocaleString()} KO${summary.kos === 1 ? '' : 's'} × ${summary.samples.toLocaleString()} timepoints · ${summary.genes.toLocaleString()} gene records`}
          </div>
        )}
        {summary && summary.unknown_kos.length > 0 && (
          <div data-testid="bytaxon-unknown" style={{ font: '12px var(--sans)', color: 'var(--amber)', marginTop: 6, overflowWrap: 'anywhere' }}>
            ⚠ Not in the data, left out: {summary.unknown_kos.join(', ')}
          </div>
        )}
        {tooBig && (
          <div data-testid="bytaxon-too-big" style={{ font: '12px var(--sans)', color: 'var(--amber)', marginTop: 6 }}>
            ⚠ That is over the {summary!.max_genes.toLocaleString()} limit. Choose fewer KOs or narrow the date range.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
          {canDownload ? (
            <form
              data-testid="bytaxon-download-form"
              method="post"
              action={`/api/series/export/by-taxon?${query}`}
              encType="text/plain"
              style={{ display: 'contents' }}
            >
              <input type="hidden" name="selection" value={selection} />
              <button type="submit" className="btn primary">↓ Download CSV</button>
            </form>
          ) : (
            <button className="btn primary" disabled>↓ Download CSV</button>
          )}
          <HelpTooltip text={COLUMNS_HELP[format]} />
        </div>
      </div>
    </div>
  )
}
