// ── CorrelatesPanel ───────────────────────────────────────────────────────────
// "Find Correlates" panel rendered below each chart card in Analyze page.
// Hits /api/correlations/family (SQL backend Tier 2): enumerates every
// eligible candidate in a chosen source, scores each against the reference
// annotation, and applies Benjamini-Hochberg FDR across that family. Every
// scored candidate comes back flagged significant (q < 0.05) or not,
// significant ones first, each group ranked by |r| -- the panel shows them
// all and marks the significant ones, so weaker matches stay visible for
// exploration.
//
// Source selection is 4 always-visible buttons (kegg/cog/enzyme/taxonomy,
// including the annotation's own source) rather than a cross/within tab --
// same-source exclusions (siblings, ancestors/descendants) are handled
// entirely server-side.
//
// Lag sign convention (from backend, unchanged from the old panel):
//   lag_hours > 0 → candidate peaks earlier than reference ("leads by")
//   lag_hours < 0 → reference peaks earlier than candidate ("lags by")
//   lag_hours = 0 → simultaneous

import { useEffect, useRef, useState } from 'react'

import type {
  ApiStatus, AnnotationSourceKey, ChartMetric, CorrMethod,
  CorrelationFamilyResult, CorrelationFamilyResponse,
} from '../../types'
import { SOURCE_TAG_CLS, taxonomyRankLabel } from '../../constants'
import { apiFetch, httpStatusFromError } from '../../utils/api'
import { ExternalLink } from '../ui/ExternalLinks'
import { HelpTooltip } from '../ui/HelpTooltip'
import { METHODS_FACTS } from '../../pages/methodsFacts'

// The widest lag the search tries (backend CORRELATION_LAGS).
const MAX_LAG_SAMPLES = Math.max(...METHODS_FACTS.correlationLags)
import { Skeleton } from '../ui/Skeleton'

const METHOD_LABEL: Record<CorrMethod, string> = {
  spearman:       'Spearman r',
  log_pearson:    'log-Pearson r',
  raw_pearson:    'Pearson r',
}

const METRIC_LABEL: Record<ChartMetric, string> = {
  egc:      'EGC',
  norm_egc: 'Relative Abundance',
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
  // Real totals before `limit` cuts the list -- null only in the
  // idle/loading/error states before a real response has landed.
  const [significantCount, setSignificantCount] = useState<number | null>(null)
  const [testedCount, setTestedCount] = useState<number | null>(null)
  const [untestedCount, setUntestedCount] = useState<number | null>(null)
  const [untestedReasons, setUntestedReasons] = useState<CorrelationFamilyResponse['untested_reasons'] | null>(null)

  // Default to enzyme (the smallest real family, ~3.5k candidates) rather
  // than taxonomy (~60k, by far the largest) -- on a cold cache this is
  // the difference between a first click taking minutes vs. potentially
  // over an hour. User can still pick any source; this only affects what's
  // pre-selected when the panel first opens.
  const defaultTarget = source === 'enzyme' ? 'cog' : 'enzyme'
  const [targetSource, setTargetSource] = useState<string>(defaultTarget)
  // Spearman by default: rank-based, so robust to the monotonic but
  // nonlinear relationships common in EGC data. Every method's p-value
  // accounts for autocorrelation via an effective sample size.
  const [method, setMethod] = useState<CorrMethod>('spearman')
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
  // 5xx. A first search of a combination normally finishes in seconds,
  // well inside the 60s proxy limit; the retry is a safety net for a slow
  // or busy server. The server saves its results a batch of candidates at
  // a time, so a retry picks up where it left off. correlation_family_endpoint is a
  // synchronous route, which FastAPI runs in a background thread -- so
  // even after this request's own timeout fires, the server keeps scoring
  // and saving batches. A client-side timeout
  // here is therefore not a real failure; it just means "ask again" gets
  // you further along, since already-saved candidates return instantly. Capped at
  // MAX_RETRIES (not truly unlimited) so a genuinely dead backend still
  // surfaces eventually rather than retrying forever.
  const MAX_RETRIES = 12

  async function fetchCorr(attempt = 0) {
    const requestId = ++requestSeqRef.current
    setData([])
    setSignificantCount(null)
    setTestedCount(null)
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
      // A cold (never-yet-saved) family normally takes seconds, but a slow
      // disk or a busy server can stretch it past apiFetch's normal 60s
      // default, so this keeps a much longer timeout as a safety net.
      // Every result is saved server-side, so the cost is one-time per
      // (ref, source, metric, method) combination, not recurring.
      const result = await apiFetch<CorrelationFamilyResponse>(url, 600_000)
      if (requestId !== requestSeqRef.current) return
      setData(result?.results ?? [])
      setSignificantCount(result?.significant_count ?? null)
      setTestedCount(result?.tested_count ?? null)
      setUntestedCount(result?.untested_count ?? null)
      setUntestedReasons(result?.untested_reasons ?? null)
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

  const fmtLag = (hours: number, samples: number) => {
    if (hours === 0) return 'no lag'
    const abs = Math.abs(hours)
    const dir = hours > 0 ? 'leads by' : 'lags by'
    // Nominal: whole samples x 4 h, which the sampling gaps stretch for a
    // few pairs (see the Methods page). At the edge of the search the real
    // offset may be longer than the window, hence "+".
    return `${dir} ≈${abs}h${Math.abs(samples) === MAX_LAG_SAMPLES ? '+' : ''}`
  }

  const lagTitle = (samples: number, significant: boolean) => [
    'Time offset, nominal at 4 h per sample. Positive = candidate peaks earlier.',
    Math.abs(samples) === MAX_LAG_SAMPLES
      ? 'At the limit of the search: the real offset may be longer.'
      : '',
    significant
      ? ''
      : 'Not significant, so this lag is mostly chance: the best of the 13 shifts tends to land near the edge of the window.',
  ].filter(Boolean).join(' ')

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
            {targetSource !== source && (
              <HelpTooltip text="Across sources nothing is excluded, so the same genes can count toward both annotations (e.g. a KEGG ortholog and its EC number), giving r near 1. Against taxonomy, r often reflects which organisms carry the gene. On relative abundance, groups that grow push other shares down. See Methods → Correlation." />
            )}
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
              <HelpTooltip text="The first time a combination (this annotation, a target source, a method and a metric) is searched, every candidate has to be scored, which takes a few seconds (longer if the server is busy). Results are saved, so the same search is near-instant afterwards." />
              {(['spearman', 'log_pearson', 'raw_pearson'] as CorrMethod[]).map(m => (
                <button
                  key={m}
                  className={`toggle-pill sm ${method === m ? 'on' : ''}`}
                  onClick={() => setMethod(m)}
                  title={`Score correlations using ${METHOD_LABEL[m]}`}
                >
                  {m}
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
                {retryAttempt > 0 && (
                  <div style={{
                    padding: '9px 12px', font: '11px var(--mono)', color: 'var(--text-dim)',
                  }}>
                    {/* Real elapsed time, not retryAttempt * 10 -- that
                        would assume every retry consumed the full
                        10-minute timeout. */}
                    {`Still working — about ${elapsedMinutes} min so far. A first search can take a while; it keeps retrying automatically, so feel free to leave this open.`}
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
                    and saving the results — try again in a few minutes.{' '}
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
            {status === 'ok' && data.length === 0 && (
              <div className="corr-empty">
                <span className="corr-empty-icon">∅</span>
                No candidates could be scored.
              </div>
            )}

            {status === 'ok' && data.length > 0 && (
              <>
                <div className="corr-legend">
                  {METHOD_LABEL[method]} · {METRIC_LABEL[metric]} · significant first, then by |r|
                  {significantCount != null && testedCount != null && (
                    <>
                      {' · '}
                      {significantCount.toLocaleString()} of {testedCount.toLocaleString()} significant (q&lt;0.05, BH-corrected)
                      <HelpTooltip text="Samples taken 4 hours apart aren't independent, so the 128 samples are worth about 30 independent observations. With that little evidence only strong correlations can be confirmed as significant, and how strong depends on how smooth the two series are and how many timepoints they share. Weaker matches are still listed for exploration. See the Methods page for details." />
                    </>
                  )}
                  {testedCount != null && testedCount > data.length && (
                    <>
                      {' · '}
                      <span className="corr-legend-warn">
                        showing top {data.length} of {testedCount.toLocaleString()} tested
                      </span>
                      <HelpTooltip text="Results are capped for performance. Significant matches are always shown first, then the strongest of the rest by |r|; every scored candidate is counted, and the significant count covers all of them." />
                    </>
                  )}
                  {untestedCount != null && untestedCount > 0 && (
                    <>
                      {' · '}
                      {untestedCount.toLocaleString()} not scored
                      {untestedReasons && (
                        <span data-testid="corr-untested-reasons">
                          {' ('}
                          {[
                            untestedReasons.too_few_points > 0 && `${untestedReasons.too_few_points.toLocaleString()} had fewer than 10 shared timepoints`,
                            untestedReasons.no_variation > 0 && `${untestedReasons.no_variation.toLocaleString()} had no variation where they overlap`,
                            untestedReasons.other > 0 && `${untestedReasons.other.toLocaleString()} could not be computed`,
                          ].filter(Boolean).join(', ')}
                          {')'}
                        </span>
                      )}
                      <HelpTooltip text="These candidates share fewer than 10 detected timepoints with this annotation (or don't vary over the ones they share), so no correlation can be measured. They are not in the tested count or the significance correction. Too few shared timepoints usually means a rare candidate; no variation means one of the two is flat wherever they overlap." />
                    </>
                  )}
                </div>

                {data.map(row => {
                  const lowN = row.n_pairs < 30
                  const posR = row.r >= 0
                  return (
                    <div
                      key={row.catalog_id}
                      className="corr-row"
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
                            <span className="corr-row-name" title={`Taxonomic rank: ${taxonomyRankLabel(row.depth)}`}>
                              ({taxonomyRankLabel(row.depth)})
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
                            className={`corr-stat-meta ${row.significant ? '' : 'corr-stat-meta-ns'}`}
                            title={lagTitle(row.lag_samples, row.significant)}
                          >
                            {fmtLag(row.lag_hours, row.lag_samples)}
                            <HelpTooltip text="Positive lag = the other annotation tends to peak earlier than this one. Negative = it peaks later. The hours are nominal: the lag shifts by whole samples, counted as 4 h each, and three gaps in the sampling (10–13 June) put the few pairs that span them up to 8 h further apart. “24h+” means the search stopped at its limit, so the real offset may be longer. For a match that is not significant the lag is faded: it is mostly chance and tends to land near the edge of the window. See the Methods page." />
                          </span>
                          <span
                            className={`corr-stat-p ${row.significant ? 'corr-stat-sig' : 'corr-stat-ns'}`}
                            title={
                              row.significant
                                ? 'Significant: Benjamini-Hochberg FDR-corrected q-value below 0.05 across this candidate family'
                                : 'Not significant: q-value (Benjamini-Hochberg FDR-corrected across this candidate family) is 0.05 or above'
                            }
                          >
                            q={row.q < 0.001 ? '<.001' : row.q.toFixed(3)}
                          </span>
                          <span
                            className="corr-stat-n"
                            title={`${row.n_pairs} co-occurring timepoints`}
                          >
                            n={row.n_pairs}
                            {lowN && (
                              // The effective-N p-value already discounts a pair
                              // with few points, so this explains the n rather
                              // than overriding the significance call.
                              <HelpTooltip text={`Only ${row.n_pairs} shared timepoints. The p-value already allows for this: with few timepoints only a very strong correlation can be significant.`} />
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
