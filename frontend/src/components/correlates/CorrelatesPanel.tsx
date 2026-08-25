// ── CorrelatesPanel ───────────────────────────────────────────────────────────
// "Find Correlates" panel rendered below each chart card in Analyze page.
// Computes Spearman CLR correlations between the reference annotation and
// all others in the selected source(s).
//
// Two tabs:
//   cross  — correlate against a different source (e.g. KEGG vs Taxonomy)
//   within — same source, filtered to exclude same-parent annotations
//
// Fetching strategy:
//   1. Fast fetch (skip_pvalue=true)  → results appear immediately
//   2. Full fetch (skip_pvalue=false) → p-values fill in silently in background
//
// Lag sign convention (from backend):
//   lag_hours > 0 → candidate peaks earlier than reference
//   lag_hours < 0 → reference peaks earlier than candidate
//   lag_hours = 0 → simultaneous

import { useEffect, useRef, useState } from 'react'

import type {
  ApiStatus, AnnotationSourceKey, CorrTab, CorrelateResult,
} from '../../types'
import { SOURCE_TAG_CLS } from '../../constants'
import { apiFetch } from '../../utils/api'
import { ExternalLink } from '../ui/ExternalLinks'
import { HelpTooltip } from '../ui/HelpTooltip'
import { Skeleton } from '../ui/Skeleton'

export function CorrelatesPanel({
  annotationId,
  source,
  onAddAnnotation,
}: {
  annotationId:    string
  source:          string
  onAddAnnotation: (annotationId: string, source: string, name: string | null) => void
}) {
  const [open,       setOpen]       = useState(false)
  const [tab,        setTab]        = useState<CorrTab>('cross')
  const [crossData,  setCrossData]  = useState<CorrelateResult[]>([])
  const [withinData, setWithinData] = useState<CorrelateResult[]>([])
  const [crossStatus,  setCrossStatus]  = useState<ApiStatus>('idle')
  const [withinStatus, setWithinStatus] = useState<ApiStatus>('idle')

  const defaultTarget = source === 'taxonomy' ? 'kegg' : 'taxonomy'
  const [targetSource, setTargetSource] = useState<string>(defaultTarget)
  const requestSeqRef = useRef<Record<CorrTab, number>>({ cross: 0, within: 0 })

  const allSources: AnnotationSourceKey[] = ['kegg', 'cog', 'enzyme', 'taxonomy']

  // Re-fetch cross data when target source changes while panel is open.
  useEffect(() => {
    if (open && tab === 'cross' && (crossStatus === 'idle' || crossStatus === 'error')) {
      void fetchCorr('cross')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSource])

  async function fetchCorr(mode: CorrTab) {
    const setStatus = mode === 'cross' ? setCrossStatus : setWithinStatus
    const setData   = mode === 'cross' ? setCrossData   : setWithinData
    const currentStatus = mode === 'cross' ? crossStatus : withinStatus
    if (currentStatus === 'loading') return

    const requestId = ++requestSeqRef.current[mode]
    setData([])
    setStatus('loading')

    try {
      const base      = `/api/annotations/correlate?source=${source}&annotation_id=${encodeURIComponent(annotationId)}&mode=${mode}`
      const modeParam = mode === 'cross' ? `&target_source=${encodeURIComponent(targetSource)}` : ''

      // Fast path — no p-values, results appear immediately.
      const fastUrl = `${base}${modeParam}&skip_pvalue=true&limit=15`
      const fast    = await apiFetch<{ data: CorrelateResult[] }>(fastUrl)
      if (requestId !== requestSeqRef.current[mode]) return
      setData(fast.data ?? [])
      setStatus('ok')

      // Background fetch — fills in p-values silently when ready.
      const fullUrl = `${base}${modeParam}&skip_pvalue=false&limit=15`
      const full    = await apiFetch<{ data: CorrelateResult[] }>(fullUrl)
      if (requestId !== requestSeqRef.current[mode]) return
      setData(full.data ?? [])
    } catch {
      if (requestId === requestSeqRef.current[mode]) {
        setStatus('error')
      }
    }
  }

  function handleOpen() {
    setOpen(o => {
      const nextOpen = !o
      if (nextOpen && (crossStatus === 'idle' || crossStatus === 'error')) {
        void fetchCorr('cross')
      }
      return nextOpen
    })
  }

  function handleTabChange(t: CorrTab) {
    setTab(t)
    if (t === 'cross' && (crossStatus === 'idle' || crossStatus === 'error')) {
      void fetchCorr('cross')
    } else if (t === 'within' && (withinStatus === 'idle' || withinStatus === 'error')) {
      void fetchCorr('within')
    }
  }

  const data   = tab === 'cross' ? crossData   : withinData
  const status = tab === 'cross' ? crossStatus : withinStatus

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
        title="Find annotations that co-vary with this one using Spearman CLR correlation"
      >
        <span className="corr-trigger-icon">∿</span>
        {open ? 'Hide Correlates' : 'Find Correlates'}
      </button>

      {open && (
        <div className="corr-panel">
          {/* ── Pill tab bar ── */}
          <div className="corr-pill-bar">
            <button
              className={`corr-pill ${tab === 'cross' ? 'corr-pill-active' : ''}`}
              onClick={() => handleTabChange('cross')}
            >
              Cross-source
              <span className="corr-pill-sub">{source} × {targetSource}</span>
            </button>
            <button
              className={`corr-pill ${tab === 'within' ? 'corr-pill-active' : ''}`}
              onClick={() => handleTabChange('within')}
            >
              Within-source
              <span className="corr-pill-sub">parent-filtered</span>
            </button>
            <div className="corr-pill-hint">
              {tab === 'cross'
                ? `Which ${targetSource} annotations co-vary with this ${source}?`
                : `Which other ${source} functions co-occur unexpectedly?`}
            </div>
            <HelpTooltip text="Cross-source compares against a different annotation type. Within-source compares against the same type, excluding siblings under the same parent." />
          </div>

          {/* ── Cross-source target selector ── */}
          {tab === 'cross' && (
            <div style={{
              display:      'flex',
              alignItems:   'center',
              gap:          6,
              padding:      '6px 10px',
              borderBottom: '1px solid var(--border)',
              background:   'var(--surface2)',
            }}>
              <span style={{
                font:       '400 10px var(--mono)',
                color:      'var(--text-dim)',
                whiteSpace: 'nowrap',
              }}>
                Compare against:
              </span>
              {allSources
                .filter(s => s !== source)
                .map(s => (
                  <button
                    key={s}
                    className={`toggle-pill sm ${targetSource === s ? 'on' : ''}`}
                    onClick={() => setTargetSource(s)}
                    title={`Correlate ${source} against ${s}`}
                  >
                    {s}
                  </button>
                ))}
            </div>
          )}

          {/* ── Results ── */}
          <div className="corr-results">
            {status === 'loading' && (
              <div style={{ padding: '4px 0' }}>
                <span className="sr-only">Computing correlations…</span>
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
                Correlation failed — check server connection.
              </div>
            )}
            {status === 'ok' && data.length === 0 && (
              <div className="corr-empty">
                <span className="corr-empty-icon">∅</span>
                No correlates above threshold (|r|{' '}
                &gt; {tab === 'cross' ? '0.2' : '0.3'}).
              </div>
            )}

            {status === 'ok' && data.length > 0 && (
              <>
                <div className="corr-legend">
                  Spearman r · CLR EGC · circular-shift permutation
                  {data.some(d => d.p_value === null) && (
                    <span className="corr-legend-loading"> · p loading…</span>
                  )}
                  {data.some(d => d.n_pairs < 30) && (
                    <span className="corr-legend-warn"> · ⚠ some n&lt;30</span>
                  )}
                </div>

                {data.map(row => {
                  const lowN = row.n_pairs < 30
                  const posR = row.spearman_r >= 0
                  return (
                    <div
                      key={`${row.annotation_id}::${row.source}`}
                      className={`corr-row ${lowN ? 'corr-row-dim' : ''}`}
                    >
                      {/* Strength bar — visual anchor behind row content */}
                      <div
                        className={`corr-r-bar ${posR ? 'corr-r-bar-pos' : 'corr-r-bar-neg'}`}
                        style={{ width: `${Math.round(row.abs_r * 100)}%` }}
                      />

                      <div className="corr-row-inner">
                        <div className="corr-row-identity">
                          <span className={`tag ${SOURCE_TAG_CLS[row.source] ?? ''}`}>
                            {row.source}
                          </span>
                          <span className="corr-row-id">
                            <ExternalLink
                              annotationId={row.annotation_id}
                              source={row.source}
                            />
                          </span>
                          {row.name && (
                            <span className="corr-row-name" title={row.name}>
                              {row.name}
                            </span>
                          )}
                        </div>

                        <div className="corr-row-stats">
                          <span
                            className={`corr-stat-r ${posR ? 'corr-stat-pos' : 'corr-stat-neg'}`}
                            title="Spearman r on CLR-transformed EGC"
                          >
                            {posR ? '+' : ''}{row.spearman_r.toFixed(3)}
                          </span>
                          <span
                            className="corr-stat-meta"
                            title="Time offset. Positive = candidate peaks earlier."
                          >
                            {fmtLag(row.lag_hours)}
                            <HelpTooltip text="Positive lag = the other annotation tends to peak earlier than this one. Negative = it peaks later." />
                          </span>
                          {row.p_value !== null ? (
                            <span
                              className={`corr-stat-p ${row.p_value < 0.05 ? 'corr-stat-sig' : 'corr-stat-ns'}`}
                              title="Circular-shift permutation p-value (n=1000, seed=42)"
                            >
                              p={row.p_value < 0.001 ? '<.001' : row.p_value.toFixed(3)}
                            </span>
                          ) : (
                            <span className="corr-stat-meta">p…</span>
                          )}
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
                              onAddAnnotation(row.annotation_id, row.source, row.name)
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
