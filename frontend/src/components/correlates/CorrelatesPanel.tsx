// ── CorrelatesPanel ───────────────────────────────────────────────────────────
// "Find Correlates" panel rendered below each chart card in Analyze page.
// Hits /api/correlations/family (SQL backend Tier 2): enumerates every
// eligible candidate in a chosen source, scores each against the reference
// annotation, and applies Benjamini-Hochberg FDR across that family. The
// backend already gates results to q < 0.05 -- everything this panel
// receives is significant, there's no client-side threshold to apply.
//
// Source selection is 4 always-visible buttons (kegg/cog/enzyme/taxonomy,
// including the annotation's own source) rather than a cross/within tab --
// same-source exclusions (siblings, ancestors/descendants) are handled
// entirely server-side.
//
// Lag sign convention (from backend, unchanged from the old panel):
//   lag_hours > 0 → candidate peaks earlier than reference
//   lag_hours < 0 → reference peaks earlier than candidate
//   lag_hours = 0 → simultaneous

import { useEffect, useRef, useState } from 'react'

import type {
  ApiStatus, AnnotationSourceKey, ChartMetric, CorrMethod, CorrelationFamilyResult,
} from '../../types'
import { SOURCE_TAG_CLS, taxonomyRankLabel } from '../../constants'
import { taxonomyDomainFromId } from '../../utils/taxonomy'
import { apiFetch } from '../../utils/api'
import { ExternalLink } from '../ui/ExternalLinks'
import { HelpTooltip } from '../ui/HelpTooltip'
import { Skeleton } from '../ui/Skeleton'

const METHOD_LABEL: Record<CorrMethod, string> = {
  spearman:       'Spearman r',
  log_pearson:    'log-Pearson r',
  raw_pearson:    'Pearson r',
  circular_shift: 'Spearman r (permutation p)',
}

const METRIC_LABEL: Record<ChartMetric, string> = {
  egc:      'EGC',
  norm_egc: 'norm EGC',
}

export function CorrelatesPanel({
  annotationId,
  source,
  onAddAnnotation,
}: {
  annotationId:    string
  source:          string
  onAddAnnotation: (annotationId: string, source: string, name: string | null) => void
}) {
  const [open,   setOpen]   = useState(false)
  const [data,   setData]   = useState<CorrelationFamilyResult[]>([])
  const [status, setStatus] = useState<ApiStatus>('idle')

  // Default to enzyme (the smallest real family, ~3.5k candidates) rather
  // than taxonomy (~60k, by far the largest) -- on a cold cache this is
  // the difference between a first click taking minutes vs. potentially
  // over an hour. User can still pick any source; this only affects what's
  // pre-selected when the panel first opens.
  const defaultTarget = source === 'enzyme' ? 'cog' : 'enzyme'
  const [targetSource, setTargetSource] = useState<string>(defaultTarget)
  const [method, setMethod] = useState<CorrMethod>('spearman')
  const [metric, setMetric] = useState<ChartMetric>('norm_egc')
  const requestSeqRef = useRef(0)
  const [retryAttempt, setRetryAttempt] = useState(0)

  const allSources: AnnotationSourceKey[] = ['kegg', 'cog', 'enzyme', 'taxonomy']

  // Re-fetch whenever any query param changes while the panel is open.
  useEffect(() => {
    if (open) void fetchCorr()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSource, method, metric])

  // circular_shift runs a real permutation test per candidate (1,000
  // reshuffles x 9 lags each) instead of one parametric pass -- measured
  // directly against the real db at ~900x slower per candidate than the
  // default method (spearman: 4ms/pair, circular_shift: 3.6s/pair). A
  // large family can take hours, not minutes, to fully populate its
  // cache. correlation_family_endpoint is a synchronous route, which
  // FastAPI runs in a background thread -- so even after this request's
  // own timeout fires, the server keeps scoring candidates and caching
  // each one individually. A client-side timeout here is therefore not a
  // real failure for this method; it just means "ask again" gets you
  // further along, since already-cached pairs return instantly. Capped at
  // MAX_CIRCULAR_SHIFT_RETRIES (not truly unlimited) so a genuinely dead
  // backend still surfaces as an error eventually rather than retrying
  // forever.
  const MAX_CIRCULAR_SHIFT_RETRIES = 12 // ~12 x 10 min = up to 2h before giving up

  async function fetchCorr(attempt = 0) {
    const requestId = ++requestSeqRef.current
    setData([])
    setStatus('loading')
    setRetryAttempt(attempt)

    try {
      const url =
        `/api/correlations/family` +
        `?ref_source=${encodeURIComponent(source)}` +
        `&ref_annotation_id=${encodeURIComponent(annotationId)}` +
        `&target_source=${encodeURIComponent(targetSource)}` +
        `&metric=${metric}` +
        `&method=${method}`
      // Cold (never-yet-cached) families can take minutes to compute --
      // well past apiFetch's normal 60s default -- so this gets a much
      // longer timeout. Every result is permanently cached server-side
      // (Tier 1), so this cost is one-time per (ref, source, metric,
      // method) combination, not recurring. 10 min covers taxonomy's
      // worst case even after the genus-and-coarser depth cutoff
      // (measured ~9 min cold against the real db); every other source
      // finishes in well under a minute.
      const result = await apiFetch<CorrelationFamilyResult[]>(url, 600_000)
      if (requestId !== requestSeqRef.current) return
      setData(result ?? [])
      setStatus('ok')
    } catch {
      if (requestId !== requestSeqRef.current) return
      if (method === 'circular_shift' && attempt < MAX_CIRCULAR_SHIFT_RETRIES) {
        void fetchCorr(attempt + 1)
        return
      }
      setStatus('error')
    }
  }

  function handleOpen() {
    setOpen(o => {
      const nextOpen = !o
      if (nextOpen && (status === 'idle' || status === 'error')) {
        void fetchCorr()
      }
      return nextOpen
    })
  }

  const fmtLag = (hours: number) => {
    if (hours === 0) return 'no lag'
    const abs = Math.abs(hours)
    const dir = hours > 0 ? 'leads by' : 'lags by'
    return `${dir} ${abs}h`
  }

  return (
    <div style={{ marginTop: 10 }}>
      <button
        className={`corr-trigger ${open ? 'corr-trigger-active' : ''}`}
        onClick={handleOpen}
        title="Find annotations that co-vary with this one"
      >
        <span className="corr-trigger-icon">∿</span>
        {open ? 'Hide Correlates' : 'Find Correlates'}
      </button>

      {open && (
        <div className="corr-panel">
          {/* ── Source selector ── */}
          <div className="corr-pill-bar">
            <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
              Compare against:
            </span>
            {allSources.map(s => (
              <button
                key={s}
                className={`toggle-pill sm ${targetSource === s ? 'on' : ''}`}
                onClick={() => setTargetSource(s)}
                title={
                  s === source
                    ? `Correlate against other ${s} annotations (siblings/ancestors/descendants excluded)`
                    : `Correlate against ${s}`
                }
              >
                {s}
              </button>
            ))}
            <HelpTooltip text="Includes this annotation's own source -- same-source candidates that are siblings, ancestors, or descendants of this one are excluded automatically to avoid compositional/containment artifacts." />
            {targetSource === 'taxonomy' && (
              <HelpTooltip text="Taxonomy candidates are limited to genus-and-coarser ranks (domain through genus). Species and strain-level taxa make up the large majority of the ~60,000 taxonomy annotations, and including them made this search too slow to run -- this keeps it fast without losing the coarser ranks most cross-source comparisons care about." />
            )}
          </div>

          {/* ── Method + metric selectors ── */}
          <div style={{
            display:      'flex',
            alignItems:   'center',
            gap:          14,
            padding:      '6px 10px',
            borderBottom: '1px solid var(--border)',
            background:   'var(--surface2)',
            flexWrap:     'wrap',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)' }}>Method:</span>
              {(['spearman', 'log_pearson', 'raw_pearson', 'circular_shift'] as CorrMethod[]).map(m => (
                <button
                  key={m}
                  className={`toggle-pill sm ${method === m ? 'on' : ''}`}
                  onClick={() => setMethod(m)}
                  title={
                    m === 'circular_shift'
                      ? 'Same Spearman r as the "spearman" option, but the significance test accounts for autocorrelation in the time series (a circular-shift permutation) instead of assuming independent timepoints. More statistically defensible, and noticeably slower on a cold (uncached) query.'
                      : `Score correlations using ${METHOD_LABEL[m]}`
                  }
                >
                  {m === 'circular_shift' ? 'circular_shift' : m}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)' }}>Metric:</span>
              {(['egc', 'norm_egc'] as ChartMetric[]).map(m => (
                <button
                  key={m}
                  className={`toggle-pill sm ${metric === m ? 'on' : ''}`}
                  onClick={() => setMetric(m)}
                  title={`Correlate on ${METRIC_LABEL[m]}`}
                >
                  {METRIC_LABEL[m]}
                </button>
              ))}
            </div>
          </div>

          {/* ── Results ── */}
          <div className="corr-results">
            {status === 'loading' && (
              <div style={{ padding: '4px 0' }}>
                <span className="sr-only">Computing correlations…</span>
                {method === 'circular_shift' && (
                  <div style={{
                    padding: '9px 12px', font: '11px var(--mono)', color: 'var(--text-dim)',
                  }}>
                    {retryAttempt === 0
                      ? 'This method is slower and can take a while on a large family. It keeps trying on its own, so feel free to leave this open.'
                      : `Still working — about ${retryAttempt * 10} min so far. Large families can take a while with this method; it keeps retrying automatically.`}
                  </div>
                )}
                {Array.from({ length: 7 }).map((_, i) => (
                  <div
                    key={i}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px' }}
                    aria-hidden="true"
                  >
                    <Skeleton height={12} width={70} radius={3} />
                    <Skeleton height={10} width={`${65 - i * 7}%`} />
                  </div>
                ))}
              </div>
            )}
            {status === 'error' && (
              <div className="corr-empty corr-empty-error">
                <span className="corr-empty-icon">⚠</span>
                {method === 'circular_shift' ? (
                  <>
                    Still not done after about {MAX_CIRCULAR_SHIFT_RETRIES * 10 / 60} hours of
                    trying — this family may just be too large for this
                    method right now. Try spearman, or a smaller target
                    source.{' '}
                  </>
                ) : (
                  <>Correlation failed — check server connection.{' '}</>
                )}
                <button
                  onClick={() => void fetchCorr()}
                  style={{
                    background:    'none',
                    border:        'none',
                    color:         'inherit',
                    textDecoration: 'underline',
                    cursor:        'pointer',
                    font:          'inherit',
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {status === 'ok' && data.length === 0 && (
              <div className="corr-empty">
                <span className="corr-empty-icon">∅</span>
                No significant correlates (q &lt; 0.05).
              </div>
            )}

            {status === 'ok' && data.length > 0 && (
              <>
                <div className="corr-legend">
                  {METHOD_LABEL[method]} · {METRIC_LABEL[metric]} · q&lt;0.05 (BH-corrected)
                  {data.some(d => d.n_pairs < 30) && (
                    <span className="corr-legend-warn"> · ⚠ some n&lt;30</span>
                  )}
                </div>

                {data.map(row => {
                  const lowN = row.n_pairs < 30
                  const posR = row.r >= 0
                  return (
                    <div
                      key={row.catalog_id}
                      className={`corr-row ${lowN ? 'corr-row-dim' : ''}`}
                    >
                      {/* Strength bar — visual anchor behind row content */}
                      <div
                        className={`corr-r-bar ${posR ? 'corr-r-bar-pos' : 'corr-r-bar-neg'}`}
                        style={{ width: `${Math.round(Math.abs(row.r) * 100)}%` }}
                      />

                      <div className="corr-row-inner">
                        <div className="corr-row-identity">
                          <span className={`tag ${SOURCE_TAG_CLS[targetSource] ?? ''}`}>
                            {targetSource}
                          </span>
                          <span className="corr-row-id">
                            <ExternalLink
                              annotationId={row.annotation_id}
                              source={targetSource}
                              name={row.name}
                            />
                          </span>
                          {targetSource === 'taxonomy' ? (
                            <span className="corr-row-name" title={`Taxonomic rank: ${taxonomyRankLabel(row.depth, taxonomyDomainFromId(row.annotation_id))}`}>
                              ({taxonomyRankLabel(row.depth, taxonomyDomainFromId(row.annotation_id))})
                            </span>
                          ) : row.name && (
                            <span className="corr-row-name" title={row.name}>
                              {row.name}
                            </span>
                          )}
                        </div>

                        <div className="corr-row-stats">
                          <span
                            className={`corr-stat-r ${posR ? 'corr-stat-pos' : 'corr-stat-neg'}`}
                            title={`${METHOD_LABEL[method]} on ${METRIC_LABEL[metric]}`}
                          >
                            {posR ? '+' : ''}{row.r.toFixed(3)}
                          </span>
                          <span
                            className="corr-stat-meta"
                            title="Time offset. Positive = candidate peaks earlier."
                          >
                            {fmtLag(row.lag_hours)}
                            <HelpTooltip text="Positive lag = the other annotation tends to peak earlier than this one. Negative = it peaks later." />
                          </span>
                          <span
                            className="corr-stat-p corr-stat-sig"
                            title="Benjamini-Hochberg FDR-corrected q-value across this candidate family"
                          >
                            q={row.q < 0.001 ? '<.001' : row.q.toFixed(3)}
                          </span>
                          <span
                            className={`corr-stat-n ${lowN ? 'corr-stat-n-warn' : ''}`}
                            title={
                              lowN
                                ? `Only ${row.n_pairs} co-occurring timepoints — treat as exploratory`
                                : `${row.n_pairs} co-occurring timepoints`
                            }
                          >
                            {lowN ? '⚠ ' : ''}n={row.n_pairs}
                            {lowN && (
                              <HelpTooltip text="Fewer than 30 overlapping timepoints — treat this correlation as exploratory, not statistically reliable." />
                            )}
                          </span>
                          <button
                            className="corr-add-btn"
                            title={`Add ${row.annotation_id} as a new chart`}
                            onClick={() =>
                              onAddAnnotation(row.annotation_id, targetSource, row.name)
                            }
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
