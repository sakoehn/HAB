// ── LeftResultList ────────────────────────────────────────────────────────────
// Left column of the Analyze page two-column workspace.
// Renders the search result rows for the active term tab, with:
//   - Source filter pills (multi-select, per-term, inherited by new tabs)
//   - Taxonomy rank filter pills (multi-select, only shown when taxonomy
//     is part of what the source filter currently includes) — narrows
//     just the taxonomy rows, other sources pass through untouched
//   - Custom checkbox per row (select for bulk add or group)
//   - Select-all / bulk action bar
//   - Result count and sort hint strip
//   - EGC bar visualization per row
//   - Per-row + button to add individual chart
//
// All checked state and action callbacks are owned by AnalyzePage —
// this component is purely presentational given those values.

import { useMemo, useRef, useState, useEffect } from 'react'

import type { AnnotationItem, SeriesCache } from '../../types'
import { SOURCE_COLORS, SOURCE_TAG_CLS, TAXONOMY_RANK_NAMES, taxonomyRankLabel } from '../../constants'
import { taxonomyDomainFromId, immediateParentSegment, homonymHints } from '../../utils/taxonomy'
import { CopyBtn } from '../ui/controls'
import { HelpTooltip } from '../ui/HelpTooltip'
import { useSampleTotal } from '../../utils/useSampleTotal'

// Stable empty set — avoids creating a new reference every render
const EMPTY_FILTER = new Set<string>()
const EMPTY_RANK_FILTER = new Set<number>()

// mean_egc here is a mean OVER THE
// SAMPLES WHERE THE ANNOTATION WAS DETECTED, not an aggregate across every
// sample -- annotation_catalog's own AVG(egc) only ever sees detected rows,
// since a sample without a detection has no annotation_series row to
// average in the first place. Without the detection count, a 9-sample
// mean and a 128-sample mean would look identical (and a 9-sample mean can
// outrank dozens of 128-sample means). The total is the real sample count
// (useSampleTotal).

export function LeftResultList({
  rows,
  termLabel,
  checkedKeys,
  seriesCache,
  rightCardKeys,
  copiedId,
  onCopy,
  onToggleCheck,
  onAddSingle,
  onAddSelected,
  onGroupSelected,
  total,
}: {
  rows:            AnnotationItem[]
  termLabel:       string
  checkedKeys:     Set<string>
  seriesCache:     SeriesCache
  rightCardKeys:   Set<string>
  copiedId:        string | null
  onCopy:          (id: string) => void
  onToggleCheck:   (key: string) => void
  onAddSingle:     (ann: AnnotationItem) => void
  onAddSelected:   () => void
  onGroupSelected: () => void
  total:           number
}) {
  const totalSamples = useSampleTotal()
  // Multi-select filter stored per term (empty Set = All)
  const [filtersByTerm, setFiltersByTerm] = useState<Record<string, Set<string>>>({})
  // Taxonomy rank multi-select filter, same per-term pattern — only ever
  // narrows the taxonomy subset of rows, never hides cog/kegg/enzyme rows
  const [rankFiltersByTerm, setRankFiltersByTerm] = useState<Record<string, Set<number>>>({})
  const prevTermRef = useRef<string>(termLabel)
  const filterSet = filtersByTerm[termLabel] ?? EMPTY_FILTER
  const rankFilterSet = rankFiltersByTerm[termLabel] ?? EMPTY_RANK_FILTER

  // When switching to a never-visited term, inherit the previous term's selection
  useEffect(() => {
    const prev = prevTermRef.current
    if (termLabel !== prev) {
      setFiltersByTerm(cur => {
        if (termLabel in cur) return cur
        return { ...cur, [termLabel]: new Set(cur[prev] ?? []) }
      })
      setRankFiltersByTerm(cur => {
        if (termLabel in cur) return cur
        return { ...cur, [termLabel]: new Set(cur[prev] ?? []) }
      })
      prevTermRef.current = termLabel
    }
  }, [termLabel])

  const toggleSource = (src: string) =>
    setFiltersByTerm(prev => {
      const next = new Set(prev[termLabel] ?? [])
      if (next.has(src)) next.delete(src); else next.add(src)
      return { ...prev, [termLabel]: next }
    })

  const clearFilter = () =>
    setFiltersByTerm(prev => ({ ...prev, [termLabel]: new Set() }))

  const toggleRank = (depth: number) =>
    setRankFiltersByTerm(prev => {
      const next = new Set(prev[termLabel] ?? [])
      if (next.has(depth)) next.delete(depth); else next.add(depth)
      return { ...prev, [termLabel]: next }
    })

  const clearRankFilter = () =>
    setRankFiltersByTerm(prev => ({ ...prev, [termLabel]: new Set() }))

  // Sources present in the current result set
  const availableSources = useMemo(
    () => [...new Set(rows.map(r => r.source))].sort(),
    [rows],
  )

  // Rank filter is only meaningful when taxonomy is actually part of what
  // the source filter currently shows — e.g. with "COG" alone selected,
  // picking a rank would filter nothing, so the pills stay hidden.
  const taxonomyIncluded = filterSet.size === 0 || filterSet.has('taxonomy')

  // Taxonomy ranks present in the current result set, in domain-to-strain order
  const availableRanks = useMemo(
    () => taxonomyIncluded
      ? [...new Set(
          rows.filter(r => r.source === 'taxonomy' && r.depth != null).map(r => r.depth as number),
        )].sort((a, b) => a - b)
      : [],
    [rows, taxonomyIncluded],
  )

  // Rows after applying source + rank filters (sort order unchanged).
  // Rank filter only ever narrows taxonomy rows — other sources have no
  // rank concept, so they pass through untouched.
  const visibleRows = useMemo(
    () => rows.filter(r => {
      if (filterSet.size > 0 && !filterSet.has(r.source)) return false
      if (rankFilterSet.size > 0 && r.source === 'taxonomy' && !rankFilterSet.has(r.depth ?? -1)) return false
      return true
    }),
    [rows, filterSet, rankFilterSet],
  )

  const maxEgc = useMemo(
    () => Math.max(...rows.map(r => r.mean_egc ?? 0), 1),
    [rows],
  )

  const visibleKeys  = visibleRows.map(r => `${r.annotation_id}::${r.source}`)
  // A same-named taxon elsewhere in the list often shares the immediate
  // parent too; for those the hint names the ancestor that differs.
  const nameHints = useMemo(() => homonymHints(visibleRows.map(r => r.annotation_id)), [visibleRows])
  const allChecked   = visibleKeys.length > 0 && visibleKeys.every(k => checkedKeys.has(k))
  const someChecked  = checkedKeys.size > 0
  const checkedCount = checkedKeys.size

  return (
    <div className="al-left-list">

      {/* ── Source filter pills — above select-all ── */}
      {availableSources.length > 1 && (
        <div className="al-source-filter">
          <button
            className={`al-source-pill ${filterSet.size === 0 ? 'al-source-pill-active' : ''}`}
            onClick={clearFilter}
          >
            All
          </button>
          <HelpTooltip text="Filters the list below without re-searching. Your filter choice is remembered per search tab." />
          {availableSources.map(src => (
            <button
              key={src}
              className={`al-source-pill tag ${SOURCE_TAG_CLS[src] ?? ''} ${filterSet.has(src) ? 'al-source-pill-active' : ''}`}
              onClick={() => toggleSource(src)}
            >
              {src}
            </button>
          ))}
        </div>
      )}

      {/* ── Taxonomy rank filter pills — narrows only the taxonomy rows ── */}
      {availableRanks.length > 1 && (
        <div className="al-source-filter al-rank-filter">
          <span className="al-rank-filter-label">Rank</span>
          <button
            className={`al-source-pill ${rankFilterSet.size === 0 ? 'al-source-pill-active' : ''}`}
            onClick={clearRankFilter}
          >
            All
          </button>
          <HelpTooltip text="Narrows taxonomy results to the selected rank(s) — cog/kegg/enzyme rows are unaffected." />
          {availableRanks.map(depth => (
            <button
              key={depth}
              className={`al-source-pill ${rankFilterSet.has(depth) ? 'al-source-pill-active' : ''}`}
              onClick={() => toggleRank(depth)}
            >
              {TAXONOMY_RANK_NAMES[depth] ?? `Level ${depth}`}
            </button>
          ))}
        </div>
      )}

      {/* ── Bulk action bar ── */}
      <div className="al-bulk-bar">
        <label
          className="al-select-all"
          title="Select or deselect all visible rows"
        >
          <input
            type="checkbox"
            checked={allChecked}
            onChange={() => {
              if (allChecked) {
                visibleKeys.forEach(k => onToggleCheck(k))
              } else {
                visibleKeys.filter(k => !checkedKeys.has(k)).forEach(k => onToggleCheck(k))
              }
            }}
          />
          <span style={{
            color:      'var(--text-dim)',
            fontSize:   11,
            fontFamily: 'var(--mono)',
          }}>
            {someChecked ? `${checkedCount} selected` : 'Select all'}
          </span>
        </label>

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          <HelpTooltip text="Check rows below to group or bulk-add them. + Add N puts each checked item on its own chart. ∑ Group sums all checked items into one combined chart (max 20). If checked items share genes (two pathways with KOs in common, or a KO and a COG for the same genes), those genes are counted once for each item they belong to." />
          <button
            className="btn sm ghost"
            onClick={onGroupSelected}
            disabled={checkedCount < 2}
            title={
              checkedCount === 0
                ? 'Check at least 2 rows to create a summed group chart'
                : checkedCount === 1
                ? 'Check at least 2 rows to group (currently 1 selected)'
                : `Sum EGC across ${checkedCount} selected annotations into one chart`
            }
          >
            ∑ Group
          </button>
          <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', margin: '0 4px' }} />
          <button
            className="btn sm primary"
            onClick={onAddSelected}
            disabled={checkedCount === 0}
            title={
              checkedCount === 0
                ? 'Check rows to add as individual charts'
                : `Add ${checkedCount} annotation${checkedCount !== 1 ? 's' : ''} as individual charts`
            }
          >
            {checkedCount > 0 ? `+ Add ${checkedCount}` : '+ Add'}
          </button>
        </div>
      </div>

      {/* ── Result info strip ── */}
      {rows.length > 0 && (
        <div className="al-result-info">
          <span className="al-result-count">
            {filterSet.size > 0 || rankFilterSet.size > 0
              ? <>{visibleRows.length.toLocaleString()} <span className="al-result-showing">of {total.toLocaleString()}</span></>
              : <>{total.toLocaleString()} result{total !== 1 ? 's' : ''}</>
            }
            {total > rows.length && (
              <span className="al-result-showing">
                {' '}· showing top {rows.length}
              </span>
            )}
          </span>
          <span className="al-result-hint">
            closest matches first, then by mean EGC
            <HelpTooltip text="EGC here is the mean across samples where the annotation was actually detected, not every sample -- an annotation detected in only a few samples can rank above one detected everywhere. Check the (N/total) next to a row's number, when shown, before comparing two rows' rank." />
            {total > rows.length && ' · refine to narrow'}
          </span>
        </div>
      )}

      {/* ── Result rows ── */}
      <div className="al-rows">
        {visibleRows.map(ann => {
          const key       = `${ann.annotation_id}::${ann.source}`
          const inRight   = rightCardKeys.has(key)
          const isChecked = checkedKeys.has(key)
          const hasMeta   = ann.mean_egc != null
          const loading   = seriesCache[key]?.status === 'loading'

          return (
            <div
              key={key}
              className={`al-row ${isChecked ? 'al-row-checked' : ''} ${inRight ? 'al-row-in-right' : ''}`}
            >
              {/* Custom styled checkbox */}
              <button
                className={`al-row-checkbox ${isChecked ? 'al-row-checkbox-checked' : ''}`}
                onClick={() => onToggleCheck(key)}
                title={isChecked ? 'Deselect' : 'Select for bulk add or group'}
                aria-pressed={isChecked}
              >
                {isChecked && (
                  <span className="al-row-checkbox-tick">✓</span>
                )}
              </button>

              {/* Row body — click to add single */}
              <div
                className="al-row-body"
                onClick={() => !inRight && onAddSingle(ann)}
              >
                <div className="al-row-top">
                  <CopyBtn
                    id={ann.annotation_id}
                    copiedId={copiedId}
                    onCopy={onCopy}
                  />
                  <span className="al-row-id">
                    {ann.source === 'taxonomy' ? taxonomyRankLabel(ann.depth ?? null, taxonomyDomainFromId(ann.annotation_id)) : ann.annotation_id}
                  </span>
                  <span className={`tag ${SOURCE_TAG_CLS[ann.source] ?? ''}`}>
                    {ann.source}
                  </span>
                </div>
                <div
                  className="al-row-name"
                  title={ann.source === 'taxonomy' ? ann.annotation_id : undefined}
                >
                  {ann.name ?? '—'}
                  {ann.source === 'taxonomy' && (nameHints.get(ann.annotation_id) ?? immediateParentSegment(ann.annotation_id)) && (
                    // The cheapest real
                    // disambiguator for two cross-lineage homonyms (same
                    // bare name, different ancestry) short of showing the
                    // full lineage inline -- hovering the row still shows
                    // the whole thing via the title attribute above.
                    <span className="al-row-parent-hint">
                      {' '}in {nameHints.get(ann.annotation_id) ?? immediateParentSegment(ann.annotation_id)}
                    </span>
                  )}
                </div>
                {hasMeta && (
                  <div className="al-row-meta">
                    <span
                      title={
                        ann.sample_count != null
                          ? `Mean when detected, across ${ann.sample_count} of ${totalSamples} samples`
                          : undefined
                      }
                    >
                      {(ann.mean_egc as number).toExponential(2)}
                      {ann.sample_count != null && ann.sample_count < totalSamples && (
                        <span className="al-row-detection-count">
                          {' '}({ann.sample_count}/{totalSamples})
                        </span>
                      )}
                    </span>
                    <div className="al-row-bar">
                      <div style={{
                        height:       '100%',
                        borderRadius: 2,
                        width:        `${((ann.mean_egc as number) / maxEgc) * 100}%`,
                        background:   SOURCE_COLORS[ann.source] ?? 'var(--chart-1)',
                      }} />
                    </div>
                  </div>
                )}
              </div>

              {/* + add button */}
              <button
                className={`al-add-btn ${inRight ? 'al-add-btn-added' : ''}`}
                title={
                  inRight
                    ? 'Already in view — click chart × to remove'
                    : 'Add chart to right panel'
                }
                onClick={() => !inRight && onAddSingle(ann)}
                disabled={inRight || loading}
              >
                {loading ? '…' : inRight ? '✓' : '+'}
              </button>
            </div>
          )
        })}

        {rows.length === 0 && (
          <div className="state-box" style={{ padding: '32px 16px' }}>
            <div className="state-icon">∅</div>
            <span>No results for this term.</span>
          </div>
        )}
      </div>
    </div>
  )
}
