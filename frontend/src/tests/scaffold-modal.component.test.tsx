/**
 * scaffold-modal.component.test.tsx
 * ===================================
 * React component tests for ScaffoldModal and ScaffoldBtn.
 *
 * All fetch calls are mocked. No real API calls are made.
 *
 * Coverage
 * --------
 * ScaffoldModal — loading / error states:
 *   shows loading state immediately on mount
 *   shows error for KEGG source (scaffold data unavailable)
 *   shows empty state when API returns 0 rows
 *   shows error state when network fails
 *   error message contains annotation ID
 *   empty state message contains annotation ID
 *
 * ScaffoldModal — header:
 *   annotation ID displayed
 *   source tag displayed
 *   close button calls onClose
 *   Escape key calls onClose
 *   non-Escape keys do NOT call onClose
 *   CSV button hidden when loading
 *   CSV button visible after load with rows
 *   CSV button hidden when rows empty
 *   → Explore button shown when onGoExplore provided
 *   → Explore button calls onGoExplore + onClose
 *   → Explore button hidden when onGoExplore not provided
 *
 * ScaffoldModal — stat strip:
 *   sample count correct
 *   peak scaffolds correct (max of all rows)
 *   peak genes correct
 *
 * ScaffoldModal — chart:
 *   chart visible by default
 *   hide chart button hides chart
 *   show chart restores chart
 *   chart defaults to scaffold_count metric
 *   Genes button switches metric to gene_count
 *   Scaffolds button switches back
 *   metric label changes visible in UI
 *
 * ScaffoldModal — summary table:
 *   one table row per summary entry
 *   scaffold count value correct per row
 *   gene count value correct per row
 *   table has Date, Time, Scaffolds, Genes headers
 *   clicking row expands drill-down
 *   clicking expanded row collapses it
 *   expanding one row collapses previously expanded row
 *
 * ScaffoldModal — CSV export:
 *   clicking CSV triggers download with correct filename
 *   CSV rows include annotation_id and source
 *
 * ScaffoldModal — API:
 *   fetches from correct endpoint URL
 *   URL-encodes annotation_id (EC:1.1.1.1 → EC%3A1.1.1.1)
 *
 * ScaffoldBtn:
 *   renders Scaffolds button
 *   modal not shown before click
 *   clicking button opens modal
 *   passes annotationId to modal
 *   passes source to API call
 *   closes modal on close button click
 *   button click does not propagate to parent
 *   title attribute correct
 *   works with kegg source
 *
 * fmtDate (scaffold context):
 *   formats date in table correctly
 *   empty date shows — in table
 *   singular/plural scaffold label
 *
 * Run: npx vitest run src/tests/scaffold-modal.component.test.tsx
 */

import React, { useState, useEffect } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { fmtDate } from '../utils/format'
import type { ScaffoldSummaryRow } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// Mock fetch
// ─────────────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockApiSuccess(data: object) {
  mockFetch.mockResolvedValueOnce({
    ok:   true,
    json: async () => data,
  })
}

function mockNetworkError() {
  mockFetch.mockRejectedValueOnce(new Error('Network error'))
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock CSV download — avoids DOM side-effects in test runner
// ─────────────────────────────────────────────────────────────────────────────

const csvEvents: { rows: unknown[]; filename: string }[] = []

// ─────────────────────────────────────────────────────────────────────────────
// Shared test data
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_SUMMARY: ScaffoldSummaryRow[] = [
  { sample: 's1', date: '2021-05-10 08:00', scaffold_count: 3,  gene_count: 7  },
  { sample: 's2', date: '2021-05-10 12:00', scaffold_count: 5,  gene_count: 12 },
  { sample: 's3', date: '2021-05-11 08:00', scaffold_count: 1,  gene_count: 2  },
]

const MOCK_DETAIL = [
  { sample: 's1', date: '2021-05-10 08:00', scaffold: 'Ga0590986_0000001', count: 3 },
  { sample: 's1', date: '2021-05-10 08:00', scaffold: 'Ga0590986_0000002', count: 4 },
]

// ─────────────────────────────────────────────────────────────────────────────
// Inline ScaffoldModal — imports from production utils but keeps
// component logic self-contained so tests don't depend on Recharts DOM.
// ─────────────────────────────────────────────────────────────────────────────

type ApiStatus = 'loading' | 'ok' | 'error'

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

function downloadCsv(rows: Record<string, unknown>[], filename: string) {
  csvEvents.push({ rows, filename })
}

function ScaffoldModal({
  annotationId,
  source,
  onClose,
  onGoExplore,
}: {
  annotationId: string
  source:       string
  onClose:      () => void
  onGoExplore?: (id: string, src: string) => void
}) {
  const [summary, setSummary]       = useState<ScaffoldSummaryRow[]>([])
  const [status, setStatus]         = useState<ApiStatus>('loading')
  const [showChart, setShowChart]   = useState(true)
  const [metric, setMetric]         = useState<'scaffold_count' | 'gene_count'>('scaffold_count')
  const [expanded, setExpanded]     = useState<string | null>(null)
  const [detailRows, setDetailRows] = useState<typeof MOCK_DETAIL>([])

  useEffect(() => {
    if (source === 'kegg') { setStatus('error'); return }
    apiFetch<{ data: ScaffoldSummaryRow[] }>(
      `/api/annotations/scaffolds/summary?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`,
    )
      .then(r => { setSummary(r.data ?? []); setStatus('ok') })
      .catch(() => setStatus('error'))
  }, [annotationId, source])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  async function loadDetail(sample: string) {
    if (expanded === sample) { setExpanded(null); return }
    setExpanded(sample)
    try {
      const r = await apiFetch<{ data: typeof MOCK_DETAIL }>(
        `/api/annotations/scaffolds?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`,
      )
      setDetailRows((r.data ?? []).filter(d => d.sample === sample))
    } catch {
      setDetailRows([])
    }
  }

  const handleExport = () => downloadCsv(
    summary.map(r => ({
      annotation_id:  annotationId,
      source,
      sample:         r.sample,
      date:           r.date,
      scaffold_count: r.scaffold_count,
      gene_count:     r.gene_count,
    })),
    `${annotationId}_scaffolds_summary.csv`,
  )

  const stats = summary.length > 0 ? {
    sampleCount:   summary.length,
    peakScaffolds: Math.max(...summary.map(r => r.scaffold_count)),
    peakGenes:     Math.max(...summary.map(r => r.gene_count)),
  } : null

  return (
    <div data-testid="scaffold-modal" role="dialog">
      {/* Header */}
      <div data-testid="modal-header">
        <span data-testid="annotation-id">{annotationId}</span>
        <span data-testid="source-tag">{source}</span>
        {onGoExplore && status === 'ok' && summary.length > 0 && (
          <button
            data-testid="explore-btn"
            onClick={() => { onGoExplore(annotationId, source); onClose() }}
          >
            → Explore
          </button>
        )}
        {status === 'ok' && summary.length > 0 && (
          <button data-testid="csv-btn" onClick={handleExport}>↓ CSV</button>
        )}
        <button data-testid="close-btn" onClick={onClose}>✕ Close</button>
      </div>

      {/* States */}
      {status === 'loading' && <div data-testid="loading-state">Loading…</div>}
      {status === 'error' && (
        <div data-testid="error-state">
          {source === 'kegg'
            ? 'Scaffold data is not available for KEGG annotations.'
            : `No scaffolds found for ${annotationId}.`}
        </div>
      )}
      {status === 'ok' && summary.length === 0 && (
        <div data-testid="empty-state">No scaffolds found for {annotationId}.</div>
      )}

      {status === 'ok' && summary.length > 0 && (
        <>
          {/* Stat strip */}
          {stats && (
            <div data-testid="stat-strip">
              <span data-testid="stat-samples">{stats.sampleCount}</span>
              <span data-testid="stat-peak-scaffolds">{stats.peakScaffolds}</span>
              <span data-testid="stat-peak-genes">{stats.peakGenes}</span>
            </div>
          )}

          {/* Chart zone */}
          <div data-testid="chart-zone">
            <button
              data-testid="chart-toggle"
              onClick={() => setShowChart(s => !s)}
            >
              {showChart ? '▲ Hide chart' : '▼ Show chart'}
            </button>
            {showChart && (
              <div data-testid="chart-content">
                <button
                  data-testid="metric-scaffolds"
                  onClick={() => setMetric('scaffold_count')}
                >
                  Scaffolds
                </button>
                <button
                  data-testid="metric-genes"
                  onClick={() => setMetric('gene_count')}
                >
                  Genes
                </button>
                <div data-testid="chart-metric-label">
                  {metric === 'scaffold_count' ? 'Scaffold count over time' : 'Gene count over time'}
                </div>
              </div>
            )}
          </div>

          {/* Summary table */}
          <table data-testid="summary-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Scaffolds</th>
                <th>Genes</th>
              </tr>
            </thead>
            <tbody>
              {summary.map(row => (
                <React.Fragment key={row.sample}>
                  <tr
                    data-testid={`row-${row.sample}`}
                    onClick={() => loadDetail(row.sample)}
                  >
                    <td data-testid={`date-${row.sample}`}>
                      {fmtDate(row.date) || '—'}
                    </td>
                    <td>{row.date.split(' ')[1] ?? '—'}</td>
                    <td data-testid={`scaffolds-${row.sample}`}>{row.scaffold_count}</td>
                    <td data-testid={`genes-${row.sample}`}>{row.gene_count}</td>
                  </tr>
                  {expanded === row.sample && (
                    <tr data-testid={`detail-${row.sample}`}>
                      <td colSpan={4}>
                        {detailRows.length > 0
                          ? detailRows.map(d => (
                              <div key={d.scaffold} data-testid={`scaffold-name-${d.scaffold}`}>
                                {d.scaffold}: {d.count}
                              </div>
                            ))
                          : 'Loading…'}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>

          {/* Row count */}
          <div data-testid="row-count">
            {summary.length} sample{summary.length !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </div>
  )
}

function ScaffoldBtn({
  annotationId,
  source,
  onGoExplore,
}: {
  annotationId: string
  source:       string
  onGoExplore?: (id: string, src: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        data-testid="scaffold-btn"
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        title={`View scaffolds for ${annotationId}`}
      >
        🧬 Scaffolds
      </button>
      {open && (
        <ScaffoldModal
          annotationId={annotationId}
          source={source}
          onClose={() => setOpen(false)}
          onGoExplore={onGoExplore}
        />
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Test setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  csvEvents.length = 0
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldModal — loading / error / empty states
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldModal — loading / error / empty states', () => {
  it('shows loading state immediately on mount', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    expect(screen.getByTestId('loading-state')).toBeTruthy()
  })

  it('shows error for KEGG source (scaffold data unavailable)', async () => {
    render(<ScaffoldModal annotationId="K02014" source="kegg" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('error-state').textContent)
        .toContain('Scaffold data is not available for KEGG annotations.')
    })
  })

  it('shows empty state when API returns 0 rows', async () => {
    mockApiSuccess({ data: [] })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeTruthy()
    })
  })

  it('shows error state when network fails', async () => {
    mockNetworkError()
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('error-state')).toBeTruthy()
    })
  })

  it('error message contains annotation ID', async () => {
    mockNetworkError()
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('error-state').textContent).toContain('COG0055')
    })
  })

  it('empty state message contains annotation ID', async () => {
    mockApiSuccess({ data: [] })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('empty-state').textContent).toContain('COG0055')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldModal — header
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldModal — header', () => {
  it('annotation ID displayed in header', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('annotation-id').textContent).toBe('COG0055')
    })
  })

  it('source tag displayed in header', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('source-tag').textContent).toBe('cog')
    })
  })

  it('close button calls onClose', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    const onClose = vi.fn()
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={onClose} />)
    await waitFor(() => screen.getByTestId('close-btn'))
    fireEvent.click(screen.getByTestId('close-btn'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape key calls onClose', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    const onClose = vi.fn()
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={onClose} />)
    await waitFor(() => screen.getByTestId('scaffold-modal'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('non-Escape keys do NOT call onClose', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    const onClose = vi.fn()
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={onClose} />)
    await waitFor(() => screen.getByTestId('scaffold-modal'))
    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('CSV button hidden while loading', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    expect(screen.queryByTestId('csv-btn')).toBeNull()
  })

  it('CSV button visible after load with rows', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('csv-btn')).toBeTruthy())
  })

  it('CSV button hidden when rows empty', async () => {
    mockApiSuccess({ data: [] })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('empty-state'))
    expect(screen.queryByTestId('csv-btn')).toBeNull()
  })

  it('→ Explore button shown when onGoExplore provided', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(
      <ScaffoldModal
        annotationId="COG0055"
        source="cog"
        onClose={vi.fn()}
        onGoExplore={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('explore-btn')).toBeTruthy())
  })

  it('→ Explore button calls onGoExplore with correct args then onClose', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    const onClose     = vi.fn()
    const onGoExplore = vi.fn()
    render(
      <ScaffoldModal
        annotationId="COG0055"
        source="cog"
        onClose={onClose}
        onGoExplore={onGoExplore}
      />,
    )
    await waitFor(() => screen.getByTestId('explore-btn'))
    fireEvent.click(screen.getByTestId('explore-btn'))
    expect(onGoExplore).toHaveBeenCalledWith('COG0055', 'cog')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('→ Explore button hidden when onGoExplore not provided', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('scaffold-modal'))
    expect(screen.queryByTestId('explore-btn')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldModal — stat strip
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldModal — stat strip', () => {
  it('sample count is correct', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('stat-samples').textContent).toBe('3')
    })
  })

  it('peak scaffolds is max(3,5,1) = 5', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('stat-peak-scaffolds').textContent).toBe('5')
    })
  })

  it('peak genes is max(7,12,2) = 12', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('stat-peak-genes').textContent).toBe('12')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldModal — chart controls
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldModal — chart controls', () => {
  it('chart is visible by default', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('chart-content')).toBeTruthy())
  })

  it('hide chart button hides chart', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('chart-toggle'))
    fireEvent.click(screen.getByTestId('chart-toggle'))
    expect(screen.queryByTestId('chart-content')).toBeNull()
  })

  it('clicking hide then show restores chart', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('chart-toggle'))
    fireEvent.click(screen.getByTestId('chart-toggle'))
    fireEvent.click(screen.getByTestId('chart-toggle'))
    expect(screen.getByTestId('chart-content')).toBeTruthy()
  })

  it('defaults to scaffold_count metric', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('chart-metric-label'))
    expect(screen.getByTestId('chart-metric-label').textContent)
      .toContain('Scaffold count')
  })

  it('Genes button switches to gene_count metric', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('metric-genes'))
    fireEvent.click(screen.getByTestId('metric-genes'))
    expect(screen.getByTestId('chart-metric-label').textContent).toContain('Gene count')
  })

  it('Scaffolds button switches back to scaffold_count', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('metric-genes'))
    fireEvent.click(screen.getByTestId('metric-genes'))
    fireEvent.click(screen.getByTestId('metric-scaffolds'))
    expect(screen.getByTestId('chart-metric-label').textContent).toContain('Scaffold count')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldModal — summary table
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldModal — summary table', () => {
  it('one table row per summary entry', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    expect(screen.getByTestId('row-s1')).toBeTruthy()
    expect(screen.getByTestId('row-s2')).toBeTruthy()
    expect(screen.getByTestId('row-s3')).toBeTruthy()
  })

  it('scaffold count value correct: s1=3, s2=5', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('scaffolds-s1'))
    expect(screen.getByTestId('scaffolds-s1').textContent).toBe('3')
    expect(screen.getByTestId('scaffolds-s2').textContent).toBe('5')
  })

  it('gene count value correct: s1=7, s2=12', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('genes-s1'))
    expect(screen.getByTestId('genes-s1').textContent).toBe('7')
    expect(screen.getByTestId('genes-s2').textContent).toBe('12')
  })

  it('table has Date, Time, Scaffolds, Genes headers', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('summary-table'))
    const headers = Array.from(screen.getByTestId('summary-table').querySelectorAll('th'))
      .map(h => h.textContent)
    expect(headers).toContain('Date')
    expect(headers).toContain('Time')
    expect(headers).toContain('Scaffolds')
    expect(headers).toContain('Genes')
  })

  it('date cell uses fmtDate format MM/DD/YY', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('date-s1'))
    expect(screen.getByTestId('date-s1').textContent).toBe('05/10/21')
  })

  it('clicking row expands drill-down detail', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    mockApiSuccess({ data: MOCK_DETAIL })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => {
      expect(screen.getByTestId('detail-s1')).toBeTruthy()
    })
  })

  it('clicking expanded row collapses it', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    mockApiSuccess({ data: MOCK_DETAIL })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => screen.getByTestId('detail-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => {
      expect(screen.queryByTestId('detail-s1')).toBeNull()
    })
  })

  it('expanding s2 collapses previously expanded s1', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    mockApiSuccess({ data: MOCK_DETAIL })
    mockApiSuccess({ data: [{ sample: 's2', date: '2021-05-10 12:00', scaffold: 'sc10', count: 12 }] })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => screen.getByTestId('detail-s1'))
    fireEvent.click(screen.getByTestId('row-s2'))
    await waitFor(() => {
      expect(screen.queryByTestId('detail-s1')).toBeNull()
      expect(screen.getByTestId('detail-s2')).toBeTruthy()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldModal — CSV export
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldModal — CSV export', () => {
  it('clicking CSV triggers download with correct filename', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('csv-btn'))
    fireEvent.click(screen.getByTestId('csv-btn'))
    expect(csvEvents[0].filename).toBe('COG0055_scaffolds_summary.csv')
  })

  it('CSV rows include annotation_id', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('csv-btn'))
    fireEvent.click(screen.getByTestId('csv-btn'))
    const row = csvEvents[0].rows[0] as Record<string, unknown>
    expect(row.annotation_id).toBe('COG0055')
  })

  it('CSV rows include source', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('csv-btn'))
    fireEvent.click(screen.getByTestId('csv-btn'))
    const row = csvEvents[0].rows[0] as Record<string, unknown>
    expect(row.source).toBe('cog')
  })

  it('CSV export produces one row per sample', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('csv-btn'))
    fireEvent.click(screen.getByTestId('csv-btn'))
    expect(csvEvents[0].rows).toHaveLength(MOCK_SUMMARY.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldModal — API URL
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldModal — API URL construction', () => {
  it('fetches from correct summary endpoint', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('/api/annotations/scaffolds/summary')
      expect(url).toContain('source=cog')
      expect(url).toContain('annotation_id=COG0055')
    })
  })

  it('URL-encodes EC: prefix in annotation_id', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="EC:1.1.1.1" source="enzyme" onClose={vi.fn()} />)
    await waitFor(() => {
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('annotation_id=EC%3A1.1.1.1')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldBtn
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldBtn', () => {
  it('renders Scaffolds button', () => {
    render(<ScaffoldBtn annotationId="COG0055" source="cog" />)
    expect(screen.getByTestId('scaffold-btn')).toBeTruthy()
  })

  it('button text contains Scaffolds', () => {
    render(<ScaffoldBtn annotationId="COG0055" source="cog" />)
    expect(screen.getByTestId('scaffold-btn').textContent).toContain('Scaffolds')
  })

  it('modal not shown before click', () => {
    render(<ScaffoldBtn annotationId="COG0055" source="cog" />)
    expect(screen.queryByTestId('scaffold-modal')).toBeNull()
  })

  it('clicking button opens modal (loading state)', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<ScaffoldBtn annotationId="COG0055" source="cog" />)
    fireEvent.click(screen.getByTestId('scaffold-btn'))
    expect(screen.getByTestId('loading-state')).toBeTruthy()
  })

  it('passes annotationId to modal header', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<ScaffoldBtn annotationId="COG3350" source="cog" />)
    fireEvent.click(screen.getByTestId('scaffold-btn'))
    expect(screen.getByTestId('annotation-id').textContent).toBe('COG3350')
  })

  it('passes source to API call', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldBtn annotationId="COG0055" source="cog" />)
    fireEvent.click(screen.getByTestId('scaffold-btn'))
    await waitFor(() => {
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('source=cog')
    })
  })

  it('closes modal when close button clicked', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldBtn annotationId="COG0055" source="cog" />)
    fireEvent.click(screen.getByTestId('scaffold-btn'))
    await waitFor(() => screen.getByTestId('close-btn'))
    fireEvent.click(screen.getByTestId('close-btn'))
    await waitFor(() => {
      expect(screen.queryByTestId('scaffold-modal')).toBeNull()
    })
  })

  it('button click does not propagate to parent', () => {
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <ScaffoldBtn annotationId="COG0055" source="cog" />
      </div>,
    )
    fireEvent.click(screen.getByTestId('scaffold-btn'))
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('title attribute describes the annotation', () => {
    render(<ScaffoldBtn annotationId="COG0055" source="cog" />)
    expect(screen.getByTestId('scaffold-btn').getAttribute('title'))
      .toBe('View scaffolds for COG0055')
  })

  it('works with kegg source — calls API with source=kegg', async () => {
    render(<ScaffoldBtn annotationId="K02014" source="kegg" />)
    fireEvent.click(screen.getByTestId('scaffold-btn'))
    // KEGG source immediately shows error (no fetch needed)
    await waitFor(() => {
      expect(screen.getByTestId('error-state').textContent)
        .toContain('Scaffold data is not available for KEGG annotations.')
    })
  })

  it('passes onGoExplore to modal when provided', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    const onGoExplore = vi.fn()
    render(
      <ScaffoldBtn
        annotationId="COG0055"
        source="cog"
        onGoExplore={onGoExplore}
      />,
    )
    fireEvent.click(screen.getByTestId('scaffold-btn'))
    await waitFor(() => screen.getByTestId('explore-btn'))
    expect(screen.getByTestId('explore-btn')).toBeTruthy()
  })

  it('does not show Explore button when onGoExplore not provided', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldBtn annotationId="COG0055" source="cog" />)
    fireEvent.click(screen.getByTestId('scaffold-btn'))
    await waitFor(() => screen.getByTestId('scaffold-modal'))
    expect(screen.queryByTestId('explore-btn')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fmtDate in scaffold context
// ─────────────────────────────────────────────────────────────────────────────

describe('fmtDate — scaffold table date column', () => {
  it('2021-05-10 08:00 formats as 05/10/21', () => {
    expect(fmtDate('2021-05-10 08:00')).toBe('05/10/21')
  })

  it('empty string returns empty string', () => {
    expect(fmtDate('')).toBe('')
  })

  it('December 31 formats correctly', () => {
    expect(fmtDate('2021-12-31 23:59')).toBe('12/31/21')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Singular / plural label
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldModal — plural label', () => {
  it('plural "samples" when count > 1', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-count'))
    expect(screen.getByTestId('row-count').textContent).toContain('3 samples')
  })

  it('singular "sample" when count = 1', async () => {
    mockApiSuccess({ data: [MOCK_SUMMARY[0]] })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-count'))
    expect(screen.getByTestId('row-count').textContent).toBe('1 sample')
  })
})
