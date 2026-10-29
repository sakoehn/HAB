// ── PathReviewList ────────────────────────────────────────────────────────────
// Bulk Download's review list for terms reached through more than one path
// inside the starting term (KEGG KOs in several pathways). Each term can be
// opened to tick or untick its paths; paths arrive from
// /api/series/export/review already sorted by the abundance of the path's
// parent, most abundant first. Choices are held by the parent panel as a set
// of "term|pathParent" keys of UNticked paths, so everything starts ticked.

import React, { useState } from 'react'

import { pathKey } from '../../utils/bulkDownload'

export type ReviewPath = {
  parent_id:       string
  parent_name:     string
  parent_mean_egc: number
  lineage_ids:     string[]
  lineage_names:   string[]
}

export type ReviewTerm = {
  annotation_id: string
  name:          string
  total_paths:   number
  paths:         ReviewPath[]
}

const PAGE = 100

export function PathReviewList({
  terms,
  excluded,
  onChange,
  termNoun,
  pathNoun,
}: {
  terms:    ReviewTerm[]
  excluded: Set<string>
  onChange: (next: Set<string>) => void
  termNoun: string
  pathNoun: string
}) {
  const [filter, setFilter]     = useState('')
  const [shown, setShown]       = useState(PAGE)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const q = filter.trim().toLowerCase()
  const matching = q
    ? terms.filter(t => t.annotation_id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
    : terms

  function setPaths(term: ReviewTerm, include: boolean) {
    const next = new Set(excluded)
    for (const p of term.paths) {
      const key = pathKey(term.annotation_id, p.parent_id)
      if (include) next.delete(key); else next.add(key)
    }
    onChange(next)
  }

  function togglePath(key: string) {
    const next = new Set(excluded)
    if (next.has(key)) next.delete(key); else next.add(key)
    onChange(next)
  }

  function toggleExpanded(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
      <div data-testid="bulk-review-note" style={{ font: '12px var(--sans)', color: 'var(--text-dim)', marginBottom: 8 }}>
        Each {termNoun}'s {pathNoun}s are sorted by the {pathNoun}'s mean EGC across all samples, most abundant
        first. That number describes the {pathNoun} as a whole, not where this {termNoun} is active — treat it as a
        hint when choosing, not proof.
      </div>
      <input
        className="field"
        style={{ width: '100%', marginBottom: 8 }}
        placeholder={`Filter ${termNoun}s by ID or name…`}
        value={filter}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setFilter(e.target.value); setShown(PAGE) }}
      />
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {matching.slice(0, shown).map(term => {
          const ticked = term.paths.filter(p => !excluded.has(pathKey(term.annotation_id, p.parent_id))).length
          const outside = term.total_paths - term.paths.length
          const open = expanded.has(term.annotation_id)
          return (
            <div key={term.annotation_id} data-testid={`bulk-review-${term.annotation_id}`} className="bulk-review-term">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button className="bulk-review-toggle" onClick={() => toggleExpanded(term.annotation_id)}>
                  <span>{open ? '▾' : '▸'}</span>
                  <span style={{ font: '12px var(--mono)', color: 'var(--text-h)' }}>{term.annotation_id}</span>
                  <span>{term.name}</span>
                </button>
                <span style={{ font: '11px var(--mono)', color: ticked === 0 ? 'var(--amber)' : 'var(--text-dim)' }}>
                  {ticked} of {term.paths.length} paths
                  {outside > 0 && ` · ${outside} more outside your start`}
                </span>
                <button className="btn sm ghost" onClick={() => setPaths(term, true)}>All</button>
                <button className="btn sm ghost" onClick={() => setPaths(term, false)}>None</button>
              </div>
              {open && (
                <div style={{ padding: '4px 0 6px 22px' }}>
                  {term.paths.map(p => {
                    const key = pathKey(term.annotation_id, p.parent_id)
                    return (
                      <label key={key} className="bulk-review-path">
                        <input
                          type="checkbox"
                          aria-label={`${term.annotation_id} in ${p.parent_name}`}
                          checked={!excluded.has(key)}
                          onChange={() => togglePath(key)}
                        />
                        <span className="bulk-review-mean">
                          {p.parent_mean_egc.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                        <span>{p.lineage_names.slice(0, -1).join(' › ')}</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        {matching.length === 0 && (
          <div style={{ font: '12px var(--sans)', color: 'var(--text-dim)', padding: 8 }}>No {termNoun}s match.</div>
        )}
      </div>
      {matching.length > shown && (
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setShown(n => n + PAGE)}>
          Show {Math.min(PAGE, matching.length - shown)} more of {matching.length - shown}
        </button>
      )}
    </div>
  )
}
