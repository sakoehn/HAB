// ── LeftResultList ────────────────────────────────────────────────────────────
// Left column of the Analyze page two-column workspace.
// Renders the search result rows for the active term tab, with:
//   - Custom checkbox per row (select for bulk add or group)
//   - Select-all / bulk action bar
//   - Result count and sort hint strip
//   - EGC bar visualization per row
//   - Per-row + button to add individual chart
//
// All checked state and action callbacks are owned by AnalyzePage —
// this component is purely presentational given those values.

import React, { useMemo } from 'react'

import type { AnnotationItem, SeriesCache, ApiStatus } from '../../types'
import { SOURCE_COLORS, SOURCE_TAG_CLS } from '../../constants'
import { CopyBtn } from '../ui/controls'

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
  const maxEgc = useMemo(
    () => Math.max(...rows.map(r => r.mean_egc ?? 0), 1),
    [rows],
  )

  const allKeys     = rows.map(r => `${r.annotation_id}::${r.source}`)
  const allChecked  = allKeys.length > 0 && allKeys.every(k => checkedKeys.has(k))
  const someChecked = checkedKeys.size > 0
  const checkedCount = checkedKeys.size

  return (
    <div className="al-left-list">

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
                allKeys.forEach(k => onToggleCheck(k))
              } else {
                allKeys.filter(k => !checkedKeys.has(k)).forEach(k => onToggleCheck(k))
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

        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
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
            {total.toLocaleString()} result{total !== 1 ? 's' : ''}
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
        {rows.map(ann => {
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
