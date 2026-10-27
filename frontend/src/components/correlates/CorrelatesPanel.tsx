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
  ApiStatus, AnnotationSourceKey, ChartMetric, CorrMethod,
  CorrelationFamilyResult, CorrelationFamilyResponse,
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

// apiFetch throws a plain Error with the
// real HTTP status as the message's leading token (e.g. "404 Not Found")
// on a non-2xx response -- extracts it so the retry logic and the error
// message can tell a real 4xx apart from a timeout/5xx instead of
// treating every failure identically.
function httpStatusFromError(err: unknown): number | null {
  if (!(err instanceof Error)) return null
  const match = /^(\d{3})\s/.exec(err.message)
  return match ? Number(match[1]) : null
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
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
  // The real total before `limit` cuts the
  // list -- null only in the idle/loading/error states before a real
  // response has landed.
  const [significantCount, setSignificantCount] = useState<number | null>(null)
  // Set only when method=circular_shift screened the family down before
  // running the expensive permutation test -- null otherwise, including
  // for every other method.
  const [prescreen, setPrescreen] = useState<{ poolSize: number; topN: number } | null>(null)

  // Default to enzyme (the smallest real family, ~3.5k candidates) rather
  // than taxonomy (~60k, by far the largest) -- on a cold cache this is
  // the difference between a first click taking minutes vs. potentially
  // over an hour. User can still pick any source; this only affects what's
  // pre-selected when the panel first opens.
  const defaultTarget = source === 'enzyme' ? 'cog' : 'enzyme'
  const [targetSource, setTargetSource] = useState<string>(defaultTarget)
  // spearman's parametric p-value ignores autocorrelation -- real EGC
  // series have lag-1 autocorrelation of 0.60-0.72, which lets 22-51% of
  // genuinely unrelated pairs pass q<0.05. circular_shift's permutation
  // null preserves each series' autocorrelation, so it's the default. User
  // can still pick spearman/log_pearson/raw_pearson for a faster look.
  const [method, setMethod] = useState<CorrMethod>('circular_shift')
  const [metric, setMetric] = useState<ChartMetric>('norm_egc')
  const requestSeqRef = useRef(0)
  const [retryAttempt, setRetryAttempt] = useState(0)
  // Real wall-clock elapsed time for the "still working"/"gave up"
  // messages, instead of assuming every retry consumed the full 10-minute
  // timeout -- a run of immediate hard failures takes nowhere near that. Set on the first attempt (attempt===0) of a fetch run,
  // read (not reset) on every subsequent retry within that same run.
  const fetchStartRef = useRef<number | null>(null)
  const [elapsedMinutes, setElapsedMinutes] = useState(0)
  const [lastErrorStatus, setLastErrorStatus] = useState<number | null>(null)

  const allSources: AnnotationSourceKey[] = ['kegg', 'cog', 'enzyme', 'taxonomy']

  // Re-fetch whenever any query param changes while the panel is open.
  useEffect(() => {
    if (open) void fetchCorr()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSource, method, metric])

  // Every method retries when a request times out or the server answers
  // 5xx: the first search of a combination can outlast the 60s proxy
  // limit, but the server keeps computing and saving each pair, so a retry
  // picks up where it left off. circular_shift is the slowest case:
  // circular_shift runs a real permutation test per candidate
  // (exhaustively over every valid shift beyond the lag window -- 103 of
  // them at the real n=128, each re-running the 13-lag search) instead of
  // one parametric pass -- measured directly against the real db at ~120x
  // slower per candidate than a fast parametric method (spearman:
  // ~3ms/pair, circular_shift: ~0.38s/pair). With prescreening capping
  // this to the strongest 200 candidates, a worst-case family finishes in
  // well under 2 minutes -- the retry affordance below is a safety net for
  // a slow cold cache. correlation_family_endpoint is a synchronous route, which
  // FastAPI runs in a background thread -- so even after this request's
  // own timeout fires, the server keeps scoring candidates and caching
  // each one individually. A client-side timeout here is therefore not a
  // real failure for this method; it just means "ask again" gets you
  // further along, since already-cached pairs return instantly. Capped at
  // MAX_RETRIES (not truly unlimited) so a genuinely dead backend still
  // surfaces eventually rather than retrying forever.
  const MAX_RETRIES = 12

  async function fetchCorr(attempt = 0) {
    const requestId = ++requestSeqRef.current
    setData([])
    setSignificantCount(null)
    setStatus('loading')
    setRetryAttempt(attempt)
    if (attempt === 0) {
      fetchStartRef.current = Date.now()
      setElapsedMinutes(0)
      setLastErrorStatus(null)
    }

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
      const result = await apiFetch<CorrelationFamilyResponse>(url, 600_000)
      if (requestId !== requestSeqRef.current) return
      setData(result?.results ?? [])
      setSignificantCount(result?.significant_count ?? null)
      setPrescreen(
        result?.prescreened && result.prescreen_pool_size != null && result.prescreen_top_n != null
          ? { poolSize: result.prescreen_pool_size, topN: result.prescreen_top_n }
          : null,
      )
      setStatus('ok')
    } catch (err) {
      if (requestId !== requestSeqRef.current) return
      // Only a real timeout/abort or a 5xx (a transient server-side issue,
      // worth another try) triggers a retry; a 4xx is a real, immediate
      // failure, not "still working" -- retrying it would fire up to 13
      // attempts back-to-back in under a second for a dead endpoint.
      const httpStatus = httpStatusFromError(err)
      setLastErrorStatus(httpStatus)
      const isRetryable = isAbortError(err) || (httpStatus != null && httpStatus >= 500)
      if (isRetryable && attempt < MAX_RETRIES) {
        setElapsedMinutes(Math.round((Date.now() - (fetchStartRef.current ?? Date.now())) / 60_000))
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
              <HelpTooltip text="The first time a combination (this annotation, a target source, a method and a metric) is searched, every candidate has to be scored, which can take a while -- up to several minutes for a large family. Results are saved, so the same search is fast afterwards." />
              {(['spearman', 'log_pearson', 'raw_pearson', 'circular_shift'] as CorrMethod[]).map(m => (
                <button
                  key={m}
                  className={`toggle-pill sm ${method === m ? 'on' : ''}`}
                  onClick={() => setMethod(m)}
                  title={
                    m === 'circular_shift'
                      ? 'Same Spearman r as the "spearman" option, but the significance test accounts for autocorrelation in the time series (a circular-shift permutation) instead of assuming independent timepoints. More statistically defensible, and noticeably slower on a cold (uncached) query. For a large family, this only runs the full permutation test on the strongest candidates from a fast pre-screen, not every candidate -- see the note above the results when that happens.'
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
                {(method === 'circular_shift' || retryAttempt > 0) && (
                  <div style={{
                    padding: '9px 12px', font: '11px var(--mono)', color: 'var(--text-dim)',
                  }}>
                    {retryAttempt === 0
                      ? 'This method is slower and can take a while on a large family. It keeps trying on its own, so feel free to leave this open.'
                      // Real elapsed time, not retryAttempt * 10 --
                      // that assumed every retry consumed the full
                      // 10-minute timeout, which a run of genuinely slow
                      // (not failed) retries roughly does, but is still
                      // measuring the real thing rather than assuming it.
                      : `Still working — about ${elapsedMinutes} min so far. A first search can take a while; it keeps retrying automatically, so feel free to leave this open.`}
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
                {/* retryAttempt > 0 here means retries actually happened
                    and were genuinely exhausted (the "still working"
                    message above was showing) -- a hard, non-retryable
                    error (4xx) stops on attempt 0 instead, with no
                    elapsed-time message to show. */}
                {retryAttempt > 0 ? (
                  <>
                    This search is taking longer than usual (about {elapsedMinutes} minute
                    {elapsedMinutes === 1 ? '' : 's'} so far). The server is still working on it
                    and saving the results — try again in a few minutes.
                    {method === 'circular_shift' && ' For a quicker look, try spearman or a smaller target source.'}{' '}
                  </>
                ) : (
                  <>
                    Correlation failed{lastErrorStatus ? ` (HTTP ${lastErrorStatus})` : ''} — check
                    server connection.{' '}
                  </>
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
            {status === 'ok' && prescreen && (
              <div className="corr-empty" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                  This family has {prescreen.poolSize.toLocaleString()} candidates —
                  circular_shift only ran its full permutation test on the
                  strongest {prescreen.topN} (by a fast pre-screen), not all
                  of them.
                </span>
                <HelpTooltip text="circular_shift is far slower than the other methods, so testing every candidate in a large family isn't practical. The candidates are first ranked by a fast method (Spearman r), and only the strongest ones go through the full, statistically rigorous permutation test. A real correlate with an unusually weak raw r could in theory be missed, but the q-values shown describe significance among the tested candidates, not the whole family." />
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
                  {significantCount != null && significantCount > data.length && (
                    <>
                      {' · '}
                      <span className="corr-legend-warn">
                        showing top {data.length} of {significantCount.toLocaleString()} significant
                      </span>
                      <HelpTooltip text="Results are capped for performance. These are the strongest matches by |r|, not the whole significant set -- there are more real correlates than shown here." />
                    </>
                  )}
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
