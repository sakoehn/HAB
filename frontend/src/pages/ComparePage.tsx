// ── ComparePage ───────────────────────────────────────────────────────────────
// Dedicated overlay page for comparing up to 4 annotation time series.
//
// State is owned by App and passed down so selections persist when the user
// navigates away and returns.
//
// Features:
//   - Search + bulk-select results (checkboxes, select-all)
//   - Up to 4 annotation slots; additional slots disabled when full
//   - Scale-mismatch warning → prompts Z-score normalize
//   - Date range filter on the overlay chart
//   - Mappings panel for each loaded annotation
//   - CSV export of all series data
//
// initialAnnotations: annotations pre-loaded from the Analyze page
// via the "→ Compare page" button in the Compare drawer.
// onConsumed: called once initialAnnotations have been loaded so App
// can clear the pending queue.

import React, { useState, useEffect } from 'react'

import type {
  CompareEntry, CompareEntryMember,
  AnnotationItem, ApiStatus, SharedAnnotation, ChartMetric,
} from '../types'
import { SOURCE_TAG_CLS, taxonomyAwarePrimaryLabel, primaryLabelWithCogCategory } from '../constants'
import { nextColorForSource, resetSourceCounters, groupSeriesColor } from '../constants'
import { apiFetch } from '../utils/api'
import { sumMembersByTimestamp, seriesMeanInRange } from '../utils/stats'
import { formatRelativeAbundancePercent, isoDate } from '../utils/format'
import { useAllSamples } from '../utils/useAllSamples'
import { useCopyId } from '../hooks/useCopyId'
import { CopyBtn, ResetBtn } from '../components/ui/controls'
import { DateRangePicker } from '../components/ui/DateRangePicker'
import { ChartErrorBoundary } from '../components/ui/ChartErrorBoundary'
import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import { MappingsPanel } from '../components/mappings/MappingsPanel'
import { GroupScaffoldModal } from '../components/scaffolds/GroupScaffoldModal'
import type { CompareState } from './compareState'

// ── State shape + default ──────────────────────────────────────────────────
// Co-located here because only ComparePage uses CompareState.

// ── Series fetch helpers ─────────────────────────────────────────────────
// Module-level — no component state needed. Shared by the initial-load
// effect and retryEntry() so a failed group member can be re-fetched and
// re-summed without duplicating this logic a third time.

async function fetchMemberSeries(
  m: { annotationId: string; source: string },
): Promise<CompareEntryMember> {
  try {
    const json = await apiFetch<{ data: AnnotationItem[] }>(
      `/api/series/annotations?source=${m.source}&annotation_id=${encodeURIComponent(m.annotationId)}&page_size=500`,
    )
    return { annotationId: m.annotationId, source: m.source, data: json.data ?? [], status: 'ok' }
  } catch {
    return { annotationId: m.annotationId, source: m.source, data: [], status: 'error' }
  }
}

// Sums both egc and norm_egc per datetime across a group's members so
// MultiEgcChart can serve raw mode and L1 mode correctly for group series.
// norm_egc = egc / total_sample_depth (pre-computed by pipeline); summing
// across members gives true depth-normalised group abundance, on the same
// scale as any single annotation's norm_egc.
//
// Thin adapter over the shared sumMembersByTimestamp (utils/stats.ts),
// which sorts by real time -- a plain string compare on the raw
// "M/D/YY H:MM" datetime would put "6/10/21" before "6/2/21". AnalyzePage.tsx
// uses the same implementation.
function sumMemberSeries(members: CompareEntryMember[], label: string): AnnotationItem[] {
  const seriesData: Record<string, AnnotationItem[]> = {}
  for (const m of members) {
    if (m.status === 'ok') seriesData[m.annotationId] = m.data
  }
  return sumMembersByTimestamp(
    members.map(m => m.annotationId), seriesData, label, members[0]?.source ?? 'kegg',
  )
}

// ── CompareFirstRunHint ──────────────────────────────────────────────────────
// Same visual pattern as AnalyzePage's FirstRunHint — reuses the existing
// .first-run-hint/.frh-* CSS, just with Compare-specific copy.

function CompareFirstRunHint() {
  return (
    <div className="first-run-hint">
      <div className="frh-steps">
        <div className="frh-step">
          <div className="frh-step-num">1</div>
          <div className="frh-step-text">
            <strong>Search</strong> for a gene function or ID above — try{' '}
            <em>iron transport</em> or <em>COG0055</em>
          </div>
        </div>
        <div className="frh-step">
          <div className="frh-step-num">2</div>
          <div className="frh-step-text">
            <strong>Check the boxes</strong> for annotations to compare (or
            click a row directly), then click &quot;Add N selected&quot;
          </div>
        </div>
        <div className="frh-step">
          <div className="frh-step-num">3</div>
          <div className="frh-step-text">
            Once you've added <strong>2 or more</strong>, an overlaid
            comparison chart appears below — up to 4 max
          </div>
        </div>
      </div>
    </div>
  )
}

// ── ComparePage ────────────────────────────────────────────────────────────

export function ComparePage({
  state,
  setState,
  initialAnnotations,
  onConsumed,
  dataDateRange,
  onGoScaffoldExplore,
  onGoScaffoldExploreGroup,
  onReset
}: {
  state:                    CompareState
  setState:                 (updater: (prev: CompareState) => CompareState) => void
  initialAnnotations:       SharedAnnotation[]
  onConsumed:               () => void
  dataDateRange?:           { min: string; max: string } | null
  onGoScaffoldExplore?:     (annotationId: string, source: string) => void
  onGoScaffoldExploreGroup?: (members: { annotationId: string; source: string }[]) => void
  onReset:                  () => void
}) {
  const { copiedId, copy } = useCopyId()
  const [scaffoldModalFor, setScaffoldModalFor] = useState<string | null>(null)
  // Annotations sent from Analyze that didn't fit in the 4 slots.
  const [handoffSkipped, setHandoffSkipped] = useState<string[]>([])

  // Load annotations arriving from the Analyze page Compare drawer.
  // They join whatever is already open: one already on the page isn't added
  // twice, and any that don't fit in the 4 slots are named in a notice.
  // Singles: fetch one series directly.
  // Groups: fetch all member series in parallel, sum by datetime — identical
  // algorithm to GroupedEgcChart/CompareDrawer so the line matches exactly.
  // All member fetches are parallel (Promise.all) → O(members) round-trips.
  // Summing is O(points × members) in memory — no extra backend calls.
  useEffect(() => {
    if (!initialAnnotations.length) return
    onConsumed()
    resetSourceCounters()

    const handoffKey = (ann: SharedAnnotation) =>
      ann.kind === 'single' ? `single:${ann.source}:${ann.annotationId}` : `group:${ann.label}`
    const openKeys = new Set(state.entries.map(e =>
      e.isGrouped ? `group:${e.annotationId}` : `single:${e.source}:${e.annotationId}`,
    ))
    const incoming = initialAnnotations.filter(ann => !openKeys.has(handoffKey(ann)))
    const freeSlots = Math.max(0, 4 - state.entries.length)
    const toLoad = incoming.slice(0, freeSlots)
    setHandoffSkipped(incoming.slice(freeSlots).map(ann =>
      ann.kind === 'single' ? ann.annotationId : ann.label,
    ))
    if (!toLoad.length) return
    const colors = toLoad.map(ann =>
      ann.kind === 'single'
        ? nextColorForSource(ann.source)
        : groupSeriesColor(0), // shown via entryColor() below, by position among groups
    )
    // Must be genuinely unique against whatever's already in state.entries
    // (manually added before this load, or surviving a previous
    // load+removal), not just unique WITHIN this one batch -- a
    // position-derived id like entry-${i} would collide with an existing
    // one after a removal shifts what "position i" means. Generated
    // once per slot here (not re-derived in the resolved-entry construction
    // below) so the optimistic and resolved versions of the same slot
    // still carry the identical id.
    const ids: string[] = toLoad.map(() => crypto.randomUUID())

    // Optimistic loading state — one entry per incoming annotation/group.
    // id is the fixed compare-slot identity for series-keying purposes
    // regardless of what two entries' labels happen to be, assigned once
    // here and carried through unchanged by the resolved-entry
    // construction below.
    setState(prev => ({
      ...prev,
      entries: [...prev.entries, ...toLoad.map((ann, i) =>
        ann.kind === 'single'
          ? {
              id:           ids[i],
              annotationId: ann.annotationId,
              source:       ann.source,
              name:         ann.name,
              data:         [],
              status:       'loading' as ApiStatus,
              color:        colors[i],
            }
          : {
              id:              ids[i],
              annotationId:    ann.label,
              source:          ann.members[0]?.source ?? 'kegg',
              name:            ann.label,
              data:            [],
              status:          'loading' as ApiStatus,
              color:           colors[i],
              isGrouped:       true,
              members:         ann.members.map(m => ({
                annotationId: m.annotationId,
                source:       m.source,
                data:         [],
                status:       'loading' as ApiStatus,
              })),
              membersExpanded: false,
            },
      )],
    }))

    // Fetch all series — singles fetch once, groups fetch all members in parallel
    Promise.all(
      toLoad.map(async (ann, i) => {
        if (ann.kind === 'single') {
          try {
            const json = await apiFetch<{ data: AnnotationItem[] }>(
              `/api/series/annotations?source=${ann.source}&annotation_id=${encodeURIComponent(ann.annotationId)}&page_size=500`,
            )
            const data = json.data ?? []
            return {
              i,
              entry: {
                id:           ids[i],
                annotationId: ann.annotationId,
                source:       ann.source,
                name:         ann.name,
                data,
                status:       (data.length > 0 ? 'ok' : 'error') as ApiStatus,
                color:        colors[i],
              } satisfies CompareEntry,
            }
          } catch {
            return {
              i,
              entry: {
                id:           ids[i],
                annotationId: ann.annotationId,
                source:       ann.source,
                name:         ann.name,
                data:         [],
                status:       'error' as ApiStatus,
                color:        colors[i],
              } satisfies CompareEntry,
            }
          }
        }

        // Group: fetch all member series in parallel, then sum by datetime.
        // O(members) parallel fetches, O(points × members) sum — fast even
        // at 128 samples × many annotations.
        const memberResults = await Promise.all(ann.members.map(fetchMemberSeries))
        const summedData    = sumMemberSeries(memberResults, ann.label)

        return {
          i,
          entry: {
            id:              ids[i],
            annotationId:    ann.label,
            source:          ann.members[0]?.source ?? 'kegg',
            name:            ann.label,
            data:            summedData,
            status:          (summedData.length > 0 ? 'ok' : 'error') as ApiStatus,
            color:           colors[i],
            isGrouped:       true,
            members:         memberResults,
            membersExpanded: false,
          } satisfies CompareEntry,
        }
      }),
    ).then(results => {
      // Merge by `id` rather than replacing `entries` wholesale: if the user
      // manually added their own annotation (search + add) while this
      // Promise.all was still in flight, a wholesale replace would drop it.
      // Merging only updates the slots THIS load actually owns, leaving
      // anything the user added (or removed) in the meantime untouched.
      const resolvedById = new Map(results.map(r => [r.entry.id, r.entry]))
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e => resolvedById.get(e.id) ?? e),
      }))
    })
  // Runs once per handover: it reads the entries open at that moment and
  // must not re-run when they change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAnnotations])

  // ── Bulk-select state ──────────────────────────────────────────────────
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set())
  // Backend's real match count for the last search -- can exceed how many
  // rows were loaded (page_size cap), so the header can say so.
  const [searchTotal, setSearchTotal] = useState<number | null>(null)
  // The overlay chart's active metric (reported via onMetricChange), so each
  // entry chip's mean is labelled and computed in the same metric -- same
  // behavior as Analyze's card-header mean.
  const [chartMetric, setChartMetric] = useState<ChartMetric>('norm_egc')
  const { allSamples } = useAllSamples()

  async function searchForAdd() {
    const q = state.query.trim()
    if (!q) return
    setState(prev => ({ ...prev, searchStatus: 'loading' }))
    setBulkSelected(new Set())
    try {
      // page_size=5000 matches Analyze's search (and /search/annotations'
      // own le=5000 cap); every loaded row is shown in the scrollable list.
      const json = await apiFetch<{ data: AnnotationItem[]; total?: number }>(
        `/api/search/annotations?q=${encodeURIComponent(q)}&sources=kegg&sources=cog&sources=enzyme&sources=taxonomy&page_size=5000`,
      )
      const seen   = new Set<string>()
      const unique = (json.data ?? []).filter(r => {
        const key = `${r.annotation_id}::${r.source}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      setSearchTotal(json.total ?? unique.length)
      setState(prev => ({ ...prev, searchResults: unique, searchStatus: 'ok' }))
    } catch {
      setState(prev => ({ ...prev, searchStatus: 'error' }))
    }
  }

  function toggleBulkSelect(annotationId: string, source: string) {
    const compositeKey = `${annotationId}::${source}`
    setBulkSelected(prev => {
      const next = new Set(prev)
      if (next.has(compositeKey)) {
        next.delete(compositeKey)
      } else if (state.entries.length + next.size < 4) {
        next.add(compositeKey)
      }
      return next
    })
  }

  async function addSelectedAnnotations() {
    const toAdd  = state.searchResults.filter(r => bulkSelected.has(`${r.annotation_id}::${r.source}`))
    if (!toAdd.length) return

    const colors = toAdd.map(ann => nextColorForSource(ann.source))
    // A length-derived id (state.entries.length) isn't collision-safe --
    // after removing an entry, the next add's id can match a surviving
    // entry's id exactly, and since `.id` is the only field used for
    // internal lookups (CSV rows, chart keying, state updates), that
    // collision would silently mutate the wrong entry.
    const newEntries: CompareEntry[] = toAdd.map((ann, i) => ({
      id:           crypto.randomUUID(),
      annotationId: ann.annotation_id,
      source:       ann.source,
      name:         ann.name,
      data:         [],
      status:       'loading' as ApiStatus,
      color:        colors[i],
    }))

    setState(prev => ({
      ...prev,
      entries:       [...prev.entries, ...newEntries].slice(0, 4),
      searchResults: [],
      query:         '',
    }))
    setBulkSelected(new Set())

    await Promise.all(toAdd.map(async (ann) => {
      try {
        const json = await apiFetch<{ data: AnnotationItem[] }>(
          `/api/series/annotations?source=${ann.source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=500`,
        )
        setState(prev => ({
          ...prev,
          entries: prev.entries.map(e =>
            e.annotationId === ann.annotation_id && e.source === ann.source
              ? { ...e, data: json.data ?? [], status: 'ok' }
              : e,
          ),
        }))
      } catch {
        setState(prev => ({
          ...prev,
          entries: prev.entries.map(e =>
            e.annotationId === ann.annotation_id && e.source === ann.source
              ? { ...e, status: 'error' }
              : e,
          ),
        }))
      }
    }))
  }

  // Legacy single-add (clicking a result row directly)
  async function addAnnotation(ann: AnnotationItem) {
    if (state.entries.length >= 4) return
    if (state.entries.some(
      e => e.annotationId === ann.annotation_id && e.source === ann.source,
    )) return

    const color = nextColorForSource(ann.source)
    // randomUUID for the same reason as addSelectedAnnotations above.
    const id    = crypto.randomUUID()
    setState(prev => ({
      ...prev,
      entries: [...prev.entries, {
        id,
        annotationId: ann.annotation_id,
        source:       ann.source,
        name:         ann.name,
        data:         [],
        status:       'loading' as ApiStatus,
        color,
      }],
      searchResults: [],
      query:         '',
    }))

    try {
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/series/annotations?source=${ann.source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=500`,
      )
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e =>
          e.annotationId === ann.annotation_id && e.source === ann.source
            ? { ...e, data: json.data ?? [], status: 'ok' }
            : e,
        ),
      }))
    } catch {
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e =>
          e.annotationId === ann.annotation_id && e.source === ann.source
            ? { ...e, status: 'error' }
            : e,
        ),
      }))
    }
  }

  // Re-fetches a failed entry in place. Grouped entries re-fetch and
  // re-sum all members (simplest correct behavior — failures here are rare
  // enough that re-fetching already-successful members isn't worth the
  // extra bookkeeping a partial-retry would need).
  async function retryEntry(entry: CompareEntry) {
    setState(prev => ({
      ...prev,
      entries: prev.entries.map(e =>
        e.id === entry.id
          ? { ...e, status: 'loading' as ApiStatus }
          : e,
      ),
    }))

    if (entry.isGrouped) {
      const memberResults = await Promise.all((entry.members ?? []).map(fetchMemberSeries))
      const summedData    = sumMemberSeries(memberResults, entry.annotationId)
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e =>
          e.id === entry.id
            ? {
                ...e,
                data:    summedData,
                status:  (summedData.length > 0 ? 'ok' : 'error') as ApiStatus,
                members: memberResults,
              }
            : e,
        ),
      }))
      return
    }

    try {
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/series/annotations?source=${entry.source}&annotation_id=${encodeURIComponent(entry.annotationId)}&page_size=500`,
      )
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e =>
          e.id === entry.id
            ? { ...e, data: json.data ?? [], status: 'ok' as ApiStatus }
            : e,
        ),
      }))
    } catch {
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e =>
          e.id === entry.id
            ? { ...e, status: 'error' as ApiStatus }
            : e,
        ),
      }))
    }
  }

  const readyEntries   = state.entries.filter(e => e.status === 'ok')
  // A group is drawn in groupSeriesColor(its position among the charted
  // groups); its chip and dot show the same. A group not on the chart yet
  // (still loading or failed) shows a neutral dot.
  const chartedGroupIds = readyEntries.filter(e => e.isGrouped).map(e => e.id)
  function entryColor(e: CompareEntry): string {
    if (!e.isGrouped) return e.color
    const i = chartedGroupIds.indexOf(e.id)
    return i >= 0 ? groupSeriesColor(i) : 'var(--text-dim)'
  }
  const slotsRemaining = 4 - state.entries.length

  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Compare Annotations</h1>
          <p className="subtitle">
            Overlay up to 4 annotations · Relative Abundance · LOWESS smooth ·
            4 max keeps the chart readable
          </p>
        </div>
        <div className="page-header-actions">
          <ResetBtn onClick={onReset} title="Clear Comparisons" label="Clear Page" small/>
        </div>
      </div>

      <div className="page-body">

        {handoffSkipped.length > 0 && (
          <div
            data-testid="compare-handoff-skipped"
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              border: '1px solid var(--border)', borderRadius: 6,
              font: '12px var(--mono)', color: 'var(--text-dim)',
            }}
          >
            <span style={{ flex: 1 }}>
              Compare holds 4 annotations, so {handoffSkipped.length === 1 ? 'this one' : 'these'} from
              Analyze {handoffSkipped.length === 1 ? 'was' : 'were'} not added: {handoffSkipped.join(', ')}.
              Remove an entry below to make room.
            </span>
            <button className="btn sm ghost" onClick={() => setHandoffSkipped([])} title="Dismiss">✕</button>
          </div>
        )}

        {/* ── Add annotations ── */}
        <div>
          <div style={{ marginBottom: 8 }}><h2>Add Annotations</h2></div>
          <div className="search-bar" style={{ marginBottom: 10 }}>
            <input
              className="field"
              placeholder="Search annotation ID or name…"
              value={state.query}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setState(prev => ({ ...prev, query: e.target.value }))
              }
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') searchForAdd()
              }}
            />
            <button
              className="btn primary"
              onClick={searchForAdd}
              disabled={state.entries.length >= 4}
            >
              Find
            </button>
          </div>

          {/* ── Search results with bulk-select ── */}
          {state.searchStatus === 'ok' && state.searchResults.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{
                background:   'var(--surface)',
                border:       '1px solid var(--border)',
                borderRadius: 8,
                overflow:     'hidden',
              }}>
                {/* Header: select-all + bulk add */}
                <div style={{
                  display:      'flex',
                  alignItems:   'center',
                  gap:          12,
                  padding:      '9px 16px',
                  background:   'var(--surface3)',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <label style={{
                    display:    'flex',
                    alignItems: 'center',
                    gap:        7,
                    cursor:     'pointer',
                    font:       '400 12px var(--mono)',
                    color:      'var(--text-dim)',
                  }}>
                    <input
                      type="checkbox"
                      checked={
                        bulkSelected.size > 0 &&
                        state.searchResults
                          .slice(0, slotsRemaining)
                          .every(r => bulkSelected.has(`${r.annotation_id}::${r.source}`))
                      }
                      onChange={() => {
                        const allSlice = state.searchResults
                          .slice(0, slotsRemaining)
                          .map(r => `${r.annotation_id}::${r.source}`)
                        const allSelected = allSlice.every(key => bulkSelected.has(key))
                        setBulkSelected(new Set(allSelected ? [] : allSlice))
                      }}
                    />
                    Select top {slotsRemaining}
                  </label>
                  <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                    {(searchTotal ?? state.searchResults.length).toLocaleString()} matches ·
                    showing {state.searchResults.length.toLocaleString()}
                    {(searchTotal ?? 0) > state.searchResults.length && (
                      <span style={{ color: 'var(--amber)' }}>
                        {' '}(highest mean EGC first — refine search to narrow)
                      </span>
                    )}
                    {' · '}{slotsRemaining} slot{slotsRemaining !== 1 ? 's' : ''} available
                  </span>
                  {bulkSelected.size > 0 ? (
                    <button
                      className="btn sm primary"
                      style={{ marginLeft: 'auto' }}
                      onClick={addSelectedAnnotations}
                    >
                      + Add {bulkSelected.size} selected
                    </button>
                  ) : (
                    <span style={{
                      marginLeft: 'auto',
                      font:       '11px var(--mono)',
                      color:      'var(--text-dim)',
                    }}>
                      Check boxes below, or click a row to add one
                    </span>
                  )}
                </div>

                {/* Result rows -- every loaded row, in a box that scrolls
                    past ~12 rows (used to hard-cut at 12 with no way to
                    see the rest). */}
                <div data-testid="compare-results-scroll" style={{ maxHeight: 500, overflowY: 'auto' }}>
                {state.searchResults.map((r, i) => {
                  const alreadyAdded = state.entries.some(
                    e => e.annotationId === r.annotation_id && e.source === r.source,
                  )
                  const isChecked = bulkSelected.has(`${r.annotation_id}::${r.source}`)
                  const canAdd    = !alreadyAdded && slotsRemaining > 0

                  return (
                    <div
                      key={i}
                      style={{
                        display:      'flex',
                        alignItems:   'center',
                        gap:          12,
                        padding:      '10px 16px',
                        cursor:       canAdd ? 'pointer' : 'default',
                        opacity:      alreadyAdded ? 0.45 : 1,
                        borderBottom: i < state.searchResults.length - 1
                          ? '1px solid var(--border)'
                          : 'none',
                        background:   isChecked ? 'var(--teal-dim)' : 'transparent',
                        transition:   'background .12s',
                      }}
                      onClick={() =>
                        canAdd && !bulkSelected.size ? addAnnotation(r) : undefined
                      }
                      onMouseEnter={e => {
                        if (!isChecked) e.currentTarget.style.background = 'var(--surface2)'
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background =
                          isChecked ? 'var(--teal-dim)' : ''
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!canAdd}
                        onChange={() => toggleBulkSelect(r.annotation_id, r.source)}
                        onClick={e => e.stopPropagation()}
                        style={{ flexShrink: 0 }}
                      />
                      <span
                        title={r.annotation_id}
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize:   13,
                          color:      'var(--teal)',
                          fontStyle:  r.source === 'taxonomy' ? 'italic' : 'normal',
                          flexShrink: r.source === 'taxonomy' ? 1 : 0,
                          minWidth:   r.source === 'taxonomy' ? 0 : undefined,
                          overflow:     r.source === 'taxonomy' ? 'hidden' : undefined,
                          textOverflow: r.source === 'taxonomy' ? 'ellipsis' : undefined,
                          whiteSpace:   'nowrap',
                        }}
                      >
                        {taxonomyAwarePrimaryLabel(r.source, r.annotation_id, r.name)}
                      </span>
                      {r.source !== 'taxonomy' && (
                        <span style={{
                          fontSize:     14,
                          color:        'var(--text-h)',
                          flex:         1,
                          overflow:     'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace:   'nowrap',
                        }}>
                          {r.name ?? '—'}
                        </span>
                      )}
                      <span className={`tag ${SOURCE_TAG_CLS[r.source] ?? ''}`}>
                        {r.source}
                      </span>
                      {alreadyAdded
                        ? <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>added</span>
                        : <span style={{ color: 'var(--teal)', fontSize: 18 }}>+</span>
                      }
                    </div>
                  )
                })}
                </div>
              </div>
            </div>
          )}

          {state.searchStatus === 'error' && (
            <div className="state-box error" style={{ padding: '12px' }}>
              <span>Search failed.</span>
            </div>
          )}
        </div>

        {/* ── Selected annotations ── */}
        {state.entries.length > 0 && (
          <div>
            <div style={{ marginBottom: 10 }}><h2>Selected Annotations</h2></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {state.entries.map(e => (
                <div key={e.id}>
                  <div className="compare-chip">
                    <div className="chip-color" style={{ background: entryColor(e) }} />
                    {e.isGrouped ? (
                      <span style={{ fontSize: 13, color: 'var(--teal)' }}>∑</span>
                    ) : (
                      <CopyBtn id={e.annotationId} copiedId={copiedId} onCopy={copy} />
                    )}
                    <span
                      title={e.annotationId}
                      style={!e.isGrouped && e.source === 'taxonomy' ? { fontStyle: 'italic' } : undefined}
                    >
                      {e.isGrouped ? e.annotationId : primaryLabelWithCogCategory(e.source, e.annotationId, e.name)}
                    </span>
                    {e.isGrouped ? (
                      <>
                        <span style={{
                          font:        '400 10px var(--mono)',
                          color:       'var(--teal)',
                          background:  'var(--teal-dim)',
                          border:      '1px solid rgba(61,217,184,.22)',
                          borderRadius: 3,
                          padding:     '1px 5px',
                        }}>
                          {e.members?.length ?? 0} annotations summed
                        </span>
                        {/*
                          This entry's top-level status stays 'ok' as long
                          as ONE member succeeded (summedData.length > 0
                          further up), so without this badge a partial
                          failure would only be visible after expanding
                          "▼ members" -- the always-visible chip would claim
                          the full member count was summed.
                        */}
                        {e.status === 'ok' && e.members?.some(m => m.status === 'error') && (
                          <span
                            data-testid="compare-entry-partial-failure"
                            style={{ font: '400 10px var(--mono)', color: 'var(--coral)' }}
                            title={`${e.members.filter(m => m.status === 'error').length} of ${e.members.length} members failed to load`}
                          >
                            ⚠ {e.members.filter(m => m.status === 'error').length} of {e.members.length} failed
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                        {e.source}
                      </span>
                    )}
                    {e.status === 'ok' && (() => {
                      // Same label/format as Analyze's card-header mean,
                      // limited to the active date filter like the chart.
                      const stats = seriesMeanInRange(e.data, chartMetric, state.dateFrom, state.dateTo)
                      if (!stats) return null
                      const inRange = allSamples?.filter(s => {
                        const iso = isoDate(s.datetime)
                        return !(state.dateFrom && iso < state.dateFrom) && !(state.dateTo && iso > state.dateTo)
                      }).length
                      return (
                        <span
                          data-testid="compare-entry-mean"
                          style={{ font: '600 11px var(--mono)', color: 'var(--text-dim)' }}
                        >
                          {chartMetric === 'norm_egc'
                            ? `mean rel. abundance ${formatRelativeAbundancePercent(stats.mean)}`
                            : `mean EGC ${stats.mean.toExponential(2)}`}
                          {' · '}{stats.n}{inRange ? ` / ${inRange}` : ''} samples
                        </span>
                      )
                    })()}
                    {e.status === 'loading' && (
                      <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>…</span>
                    )}
                    {e.status === 'error' && (
                      <span
                        data-testid="compare-entry-failed"
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--coral)' }}
                      >
                        failed to load
                        <button
                          className="btn sm"
                          data-testid="compare-entry-retry-btn"
                          style={{ padding: '1px 6px', fontSize: 10 }}
                          onClick={() => retryEntry(e)}
                        >
                          Retry
                        </button>
                      </span>
                    )}
                    {/* Expand/collapse toggle for group entries */}
                    {e.isGrouped && e.status === 'ok' && (
                      <button
                        className="btn sm ghost"
                        style={{ fontSize: 10, padding: '1px 6px' }}
                        title={e.membersExpanded ? 'Collapse member list' : 'Expand member list'}
                        onClick={() => setState(prev => ({
                          ...prev,
                          entries: prev.entries.map(x =>
                            x.id === e.id
                              ? { ...x, membersExpanded: !x.membersExpanded }
                              : x,
                          ),
                        }))}
                      >
                        {e.membersExpanded ? '▲ members' : '▼ members'}
                      </button>
                    )}
                    {e.isGrouped && e.status === 'ok' && (
                      <button
                        className="btn sm ghost"
                        style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 8px' }}
                        onClick={() => setScaffoldModalFor(e.id)}
                        title={`View scaffolds for all ${e.members?.length ?? 0} annotations in this group`}
                      >
                        🧬 Scaffolds
                      </button>
                    )}
                    <button
                      className="chip-remove"
                      onClick={() => setState(prev => {
                        // Match by id, not annotationId+source -- two
                        // different groups can share the same label, and
                        // matching by label would remove BOTH when the user
                        // meant to remove just one.
                        const next = prev.entries.filter(x => x.id !== e.id)
                        if (next.length === 0) resetSourceCounters()
                        return { ...prev, entries: next }
                      })}
                    >
                      ×
                    </button>
                  </div>

                  {e.isGrouped && scaffoldModalFor === e.id && (
                    <GroupScaffoldModal
                      members={(e.members ?? []).map(m => ({
                        annotationId: m.annotationId,
                        source:       m.source,
                        // Member names aren't stored on CompareEntryMember --
                        // non-taxonomy members show '—', same as AnalyzePage's
                        // equivalent RightGroupCard usage. Taxonomy members
                        // still get a real bare label via
                        // taxonomyAwarePrimaryLabel's id-derived fallback.
                        name: null,
                      }))}
                      groupLabel={e.annotationId}
                      onClose={() => setScaffoldModalFor(null)}
                      onGoExplore={onGoScaffoldExplore}
                      onGoExploreGroup={onGoScaffoldExploreGroup}
                    />
                  )}

                  {/* Inline member list — shown when expanded */}
                  {e.isGrouped && e.membersExpanded && e.members && (
                    <div style={{
                      marginTop:    4,
                      marginLeft:   12,
                      padding:      '8px 12px',
                      background:   'var(--surface2)',
                      border:       '1px solid var(--border)',
                      borderRadius: 6,
                      display:      'flex',
                      flexDirection: 'column',
                      gap:          4,
                      maxHeight:    200,
                      overflowY:    'auto',
                    }}>
                      <div style={{
                        font:          '600 9px var(--mono)',
                        color:         'var(--text-dim)',
                        textTransform: 'uppercase',
                        letterSpacing: '.1em',
                        marginBottom:  4,
                      }}>
                        {e.members.length} member annotations
                      </div>
                      {e.members.map(m => (
                        <div
                          key={`${m.annotationId}::${m.source}`}
                          style={{
                            display:    'flex',
                            alignItems: 'center',
                            gap:        8,
                            font:       '11px var(--mono)',
                          }}
                        >
                          <span
                            title={m.annotationId}
                            style={{
                              color:        'var(--teal)',
                              fontStyle:    m.source === 'taxonomy' ? 'italic' : 'normal',
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {primaryLabelWithCogCategory(m.source, m.annotationId, null)}
                          </span>
                          <span style={{ color: 'var(--text-dim)' }}>{m.source}</span>
                          {m.status === 'error' && (
                            <span style={{ color: 'var(--coral)', fontSize: 10 }}>
                              failed to load
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {state.entries.length < 4 && (
                <span style={{
                  fontSize:   13,
                  fontFamily: 'var(--mono)',
                  color:      'var(--text-dim)',
                  alignSelf:  'center',
                }}>
                  + add up to {4 - state.entries.length} more
                </span>
              )}
            </div>

            {/* ── Overlay chart ── */}
            {readyEntries.length > 0 && (
              <>
                <div style={{
                  display:    'flex',
                  gap:        10,
                  alignItems: 'center',
                  marginBottom: 12,
                  flexWrap:   'wrap',
                }}>
                  <DateRangePicker
                    from={state.dateFrom}
                    to={state.dateTo}
                    onFrom={v => setState(prev => ({ ...prev, dateFrom: v }))}
                    onTo={v => setState(prev => ({ ...prev, dateTo: v }))}
                    onClear={() =>
                      setState(prev => ({ ...prev, dateFrom: '', dateTo: '' }))
                    }
                    minDate={dataDateRange?.min}
                    maxDate={dataDateRange?.max}
                  />
                </div>

                {/* No page-level CSV export here -- MultiEgcChart below has
                    its own "↓ CSV" button, which reflects the chart's
                    current metric/standardize/smoothed state. This page
                    has no access to that state (it lives inside
                    MultiEgcChart, not lifted up), so a page-level export
                    could only re-derive raw EGC, which is wrong whenever
                    the chart isn't in plain raw-EGC mode. */}
                <ChartErrorBoundary label="Compare overlay">
                  <MultiEgcChart
                    series={readyEntries.map(e => ({
                      id:           e.id,
                      annotationId: e.annotationId,
                      name:         e.name,
                      data:         e.data,
                      color:        e.color,
                      source:       e.source,
                      isGrouped:    e.isGrouped ?? false,
                      // Group entries' annotationId is a synthetic label
                      // (e.g. "Grouped: label"), not a real backend
                      // annotation_id -- there's nothing for the scaffold
                      // route to look up, so the legend button is disabled
                      // for those; the group entry gets its own dedicated
                      // "🧬 Scaffolds" button + GroupScaffoldModal instead
                      // (below, in the entries panel).
                      scaffoldsDisabled: e.isGrouped ?? false,
                    }))}
                    dateFrom={state.dateFrom}
                    dateTo={state.dateTo}
                    dataDateRange={dataDateRange}
                    onGoScaffoldExplore={onGoScaffoldExplore}
                    defaultStandardize
                    onMetricChange={setChartMetric}
                  />
                </ChartErrorBoundary>
              </>
            )}

            {/* ── Mappings ── */}
            {readyEntries.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <hr className="divider" />
                <button
                  className={`mappings-toggle ${state.showMappings ? 'open' : ''}`}
                  onClick={() =>
                    setState(prev => ({ ...prev, showMappings: !prev.showMappings }))
                  }
                >
                  <span className="toggle-icon">▶</span>
                  <span className="toggle-label">
                    View Mappings for All Selected Annotations
                  </span>
                </button>
                {state.showMappings && readyEntries.map(e => (
                  <div
                    key={e.id}
                    style={{ marginBottom: 16 }}
                  >
                    <div style={{
                      marginBottom: 6,
                      display:      'flex',
                      alignItems:   'center',
                      flexWrap:     'wrap',
                      gap:          8,
                    }}>
                      <div style={{
                        width:        10,
                        height:       10,
                        borderRadius: '50%',
                        background:   entryColor(e),
                      }} />
                      <span
                        title={e.annotationId}
                        style={{
                          fontSize:   13,
                          fontFamily: 'var(--mono)',
                          color:      'var(--text-h)',
                          fontStyle:  !e.isGrouped && e.source === 'taxonomy' ? 'italic' : 'normal',
                        }}
                      >
                        {e.isGrouped ? e.annotationId : primaryLabelWithCogCategory(e.source, e.annotationId, e.name)}
                      </span>
                      <span className={`tag ${SOURCE_TAG_CLS[e.source] ?? ''}`}>
                        {e.source}
                      </span>
                    </div>
                    {e.isGrouped && e.members ? (
                      // A group's label isn't an annotation id, so mappings
                      // are listed for each member it sums.
                      <div data-testid="group-member-mappings" style={{ paddingLeft: 18 }}>
                        {e.members.map(m => (
                          <div key={`${m.source}:${m.annotationId}`} style={{ marginBottom: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                              <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text-h)' }}>
                                {m.annotationId}
                              </span>
                              <span className={`tag ${SOURCE_TAG_CLS[m.source] ?? ''}`}>{m.source}</span>
                            </div>
                            <MappingsPanel annotationId={m.annotationId} source={m.source} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <MappingsPanel
                        annotationId={e.annotationId}
                        source={e.source}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Empty state ── */}
        {state.entries.length === 0 && <CompareFirstRunHint />}

      </div>
    </div>
  )
}
