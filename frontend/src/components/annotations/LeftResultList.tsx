// ── LeftResultList ────────────────────────────────────────────────────────────
// Left column of the Analyze page two-column workspace.
// Renders the search result rows for the active term tab, with:
//   - Source filter pills (multi-select, per-term, inherited by new tabs)
//   - Custom checkbox per row (select for bulk add or group)
//   - Select-all / bulk action bar
//   - Result count and sort hint strip
//   - EGC bar visualization per row
//   - Per-row + button to add individual chart
//
// All checked state and action callbacks are owned by AnalyzePage —
// this component is purely presentational given those values.

import React, { useMemo, useRef, useState, useEffect } from 'react'

import type { AnnotationItem, SeriesCache } from '../../types'
import { SOURCE_COLORS, SOURCE_TAG_CLS } from '../../constants'
import { CopyBtn } from '../ui/controls'
import { HelpTooltip } from '../ui/HelpTooltip'

// Stable empty set — avoids creating a new reference every render
const EMPTY_FILTER = new Set<string>()

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
  // Multi-select filter stored per term (empty Set = All)
  const [filtersByTerm, setFiltersByTerm] = useState<Record<string, Set<string>>>({})
  const prevTermRef = useRef<string>(termLabel)
  const filterSet = filtersByTerm[termLabel] ?? EMPTY_FILTER

  // When switching to a never-visited term, inherit the previous term's selection
  useEffect(() => {
    const prev = prevTermRef.current
    if (termLabel !== prev) {
      setFiltersByTerm(cur => {
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

  // Sources present in the current result set
  const availableSources = useMemo(
    () => [...new Set(rows.map(r => r.source))].sort(),
    [rows],
  )

  // Rows after applying multi-select filter (sort order unchanged)
  const visibleRows = useMemo(
    () => filterSet.size === 0 ? rows : rows.filter(r => filterSet.has(r.source)),
    [rows, filterSet],
  )

  const maxEgc = useMemo(
    () => Math.max(...rows.map(r => r.mean_egc ?? 0), 1),
    [rows],
  )

  const visibleKeys  = visibleRows.map(r => `${r.annotation_id}::${r.source}`)
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

        {!someChecked && rows.length > 0 && (
          <span style={{
            font:       '10px var(--sans)',
            color:      'var(--text-dim)',
            fontStyle:  'italic',
            marginLeft: 4,
          }}>
            ← check rows to group or bulk-add
          </span>
        )}

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          <HelpTooltip text="+ Add N puts each checked item on its own chart. ∑ Group sums all checked items into one combined chart (max 20)." />
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
            {filterSet.size > 0
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
            sorted by relevance · then EGC
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
                  <span className="al-row-id">{ann.annotation_id}</span>
                  <span className={`tag ${SOURCE_TAG_CLS[ann.source] ?? ''}`}>
                    {ann.source}
                  </span>
                </div>
                <div className="al-row-name">{ann.name ?? '—'}</div>
                {hasMeta && (
                  <div className="al-row-meta">
                    <span>{(ann.mean_egc as number).toExponential(2)}</span>
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
