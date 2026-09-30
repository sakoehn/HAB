/**
 * scaffold-modal.component.test.tsx
 * ===================================
 * React component tests for ScaffoldModal and ScaffoldBtn.
 *
 * Imports the real production components (not a hand-written copy) — only
 * `downloadCsv` is mocked (via a partial mock of utils/api) to avoid real
 * DOM Blob/anchor side effects; `apiFetch` is the real implementation
 * running against a mocked global `fetch`, same as GroupScaffoldModal's
 * tests below.
 *
 * Coverage
 * --------
 * ScaffoldModal — loading / error states:
 *   shows loading state immediately on mount
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
 * ScaffoldModal — detail pagination (2026-07-28, split-collection backend):
 *   detail fetch includes sample= for the clicked row
 *   detail fetch includes page=1 and page_size=500
 *   Show all button hidden when total <= DETAIL_PAGE
 *   Show all button shows the real total, not just what's loaded so far
 *   clicking Show all fetches additional pages when total exceeds what's loaded
 *   clicking Show all does NOT re-fetch when the first page already covered everything
 *
 * GroupScaffoldModal — detail pagination:
 *   detail fetch includes sample= for the clicked row
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
 *   works with kegg source (fetches and renders normally, same as any source)
 *
 * fmtDate (scaffold context):
 *   formats date in table correctly
 *   empty date shows — in table
 *
 * Run: npx vitest run src/tests/scaffold-modal.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { fmtDate } from '../utils/format'
import type { ScaffoldSummaryRow } from '../types'
import { GroupScaffoldModal } from '../components/scaffolds/GroupScaffoldModal'
import { ScaffoldModal } from '../components/scaffolds/ScaffoldModal'
import { ScaffoldBtn } from '../components/scaffolds/ScaffoldBtn'

// ─────────────────────────────────────────────────────────────────────────────
// Partial mock of utils/api — downloadCsv only. apiFetch stays real, running
// against the mocked global fetch below, so the actual fetch/error/retry
// logic in ScaffoldModal is what's under test, not a re-implementation of it.
// ─────────────────────────────────────────────────────────────────────────────

const { csvEvents } = vi.hoisted(() => ({
  csvEvents: [] as { rows: unknown[]; filename: string }[],
}))

vi.mock('../utils/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/api')>()
  return {
    ...actual,
    downloadCsv: (rows: Record<string, unknown>[], filename: string) => {
      csvEvents.push({ rows, filename })
    },
  }
})

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

  it('error state text is distinct from empty state text (failed request != genuinely no data)', async () => {
    mockNetworkError()
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('error-state').textContent)
        .not.toBe('No scaffolds found for COG0055.')
    })
  })

  it('error state shows a retry button', async () => {
    mockNetworkError()
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTestId('retry-btn')).toBeTruthy()
    })
  })

  it('empty state does NOT show a retry button (nothing to retry)', async () => {
    mockApiSuccess({ data: [] })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('empty-state'))
    expect(screen.queryByTestId('retry-btn')).toBeNull()
  })

  it('clicking retry re-fetches and shows data on success', async () => {
    mockNetworkError()
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('retry-btn'))
    mockApiSuccess({ data: MOCK_SUMMARY })
    fireEvent.click(screen.getByTestId('retry-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('summary-table')).toBeTruthy()
    })
  })

  it('clicking retry shows loading state again while in flight', async () => {
    mockNetworkError()
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('retry-btn'))
    mockFetch.mockReturnValueOnce(new Promise(() => {}))
    fireEvent.click(screen.getByTestId('retry-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('loading-state')).toBeTruthy()
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
      .map(h => h.textContent ?? '')
    // Date/Scaffolds/Genes are sortable — real header text includes a
    // sort-direction glyph (↑/↓/↕) appended after the label.
    expect(headers.some(h => h.startsWith('Date'))).toBe(true)
    expect(headers).toContain('Time')
    expect(headers.some(h => h.startsWith('Scaffolds'))).toBe(true)
    expect(headers.some(h => h.startsWith('Genes'))).toBe(true)
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
// ScaffoldModal — detail pagination (split-collection backend, 2026-07-28)
//
// The detail fetch (triggered by clicking a summary row) used to download
// every sample's scaffolds and filter client-side. It now requests one
// sample directly and paginates, only fetching more if a single sample's
// scaffold count exceeds what the first page returned — these tests lock
// that behavior in against regressions to the old "download everything"
// pattern.
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldModal — detail pagination', () => {
  it('detail fetch includes sample= for the clicked row', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    mockApiSuccess({ data: MOCK_DETAIL, total: 2 })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => {
      const url = mockFetch.mock.calls[1][0] as string
      expect(url).toContain('sample=s1')
    })
  })

  it('detail fetch includes page=1 and page_size=500', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    mockApiSuccess({ data: MOCK_DETAIL, total: 2 })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => {
      const url = mockFetch.mock.calls[1][0] as string
      expect(url).toContain('page=1')
      expect(url).toContain('page_size=500')
    })
  })

  it('Show all button hidden when total <= DETAIL_PAGE (10)', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    mockApiSuccess({ data: MOCK_DETAIL, total: 2 })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => screen.getByTestId('detail-s1'))
    expect(screen.queryByText(/Show all/)).toBeNull()
  })

  it('Show all button shows the real total, not just what was loaded so far', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    // Server says 12 exist, but this page only returned 3 — the realistic
    // shape once a sample's scaffold count exceeds one page.
    mockApiSuccess({
      data: [
        { sample: 's1', date: '2021-05-10 08:00', scaffold: 'a', count: 1 },
        { sample: 's1', date: '2021-05-10 08:00', scaffold: 'b', count: 1 },
        { sample: 's1', date: '2021-05-10 08:00', scaffold: 'c', count: 1 },
      ],
      total: 12,
    })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => {
      expect(screen.getByText('Show all 12 scaffolds ↓')).toBeTruthy()
    })
  })

  it('clicking Show all fetches additional pages when total exceeds what is loaded', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    mockApiSuccess({
      data: [
        { sample: 's1', date: '2021-05-10 08:00', scaffold: 'a', count: 1 },
        { sample: 's1', date: '2021-05-10 08:00', scaffold: 'b', count: 1 },
        { sample: 's1', date: '2021-05-10 08:00', scaffold: 'c', count: 1 },
      ],
      total: 12,
    })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => screen.getByText('Show all 12 scaffolds ↓'))

    mockApiSuccess({
      data: Array.from({ length: 9 }, (_, i) => (
        { sample: 's1', date: '2021-05-10 08:00', scaffold: `extra-${i}`, count: 1 }
      )),
      total: 12,
    })
    fireEvent.click(screen.getByText('Show all 12 scaffolds ↓'))

    await waitFor(() => {
      const rows = screen.getByTestId('detail-s1').querySelectorAll('.scaffold-detail-table tbody tr')
      expect(rows.length).toBe(12)
    })
    // Fetch #1 = summary, #2 = detail page 1, #3 = detail page 2 (the load-more)
    expect(mockFetch.mock.calls.length).toBe(3)
    expect(mockFetch.mock.calls[2][0] as string).toContain('page=2')
  })

  it('clicking Show all does NOT re-fetch when the first page already covered everything', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    mockApiSuccess({ data: MOCK_DETAIL, total: MOCK_DETAIL.length })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))
    fireEvent.click(screen.getByTestId('row-s1'))
    await waitFor(() => screen.getByTestId('detail-s1'))

    // total (2) <= DETAIL_PAGE (10), so there's no "Show all" button to click
    // here — this confirms no phantom follow-up fetch happens on its own.
    await new Promise(r => setTimeout(r, 50))
    expect(mockFetch.mock.calls.length).toBe(2)
  })

  // W29 (docs/AUDIT-2026-09-22.md): the audit's own live example -- click
  // sample A (slow response), then sample B before A resolves. B's
  // drill-down used to show A's scaffolds once A's stale response finally
  // landed and overwrote B's real data.
  it('clicking sample A (slow), then sample B before A resolves, ends up showing B\'s real scaffolds, not A\'s stale ones', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldModal annotationId="COG0055" source="cog" onClose={vi.fn()} />)
    await waitFor(() => screen.getByTestId('row-s1'))

    let resolveS1!: (v: unknown) => void
    const s1Pending = new Promise(resolve => { resolveS1 = resolve })
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('sample=s1')) return s1Pending
      if (url.includes('sample=s2')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: [{ sample: 's2', date: '2021-05-10 12:00', scaffold: 'REAL_S2_SCAFFOLD', count: 5 }],
            total: 1,
          }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({ data: [], total: 0 }) })
    })

    fireEvent.click(screen.getByTestId('row-s1')) // slow -- still pending
    fireEvent.click(screen.getByTestId('row-s2')) // fast -- resolves first
    await waitFor(() => screen.getByText('REAL_S2_SCAFFOLD'))

    // Now let A's stale response land.
    resolveS1({
      ok: true,
      json: async () => ({
        data: [{ sample: 's1', date: '2021-05-10 08:00', scaffold: 'STALE_S1_SCAFFOLD', count: 3 }],
        total: 1,
      }),
    })
    await new Promise(r => setTimeout(r, 20))

    // Still B's real data -- A's late response must not have overwritten it.
    expect(screen.getByText('REAL_S2_SCAFFOLD')).toBeInTheDocument()
    expect(screen.queryByText('STALE_S1_SCAFFOLD')).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GroupScaffoldModal — detail pagination
// ─────────────────────────────────────────────────────────────────────────────

describe('GroupScaffoldModal — detail pagination', () => {
  it('detail fetch includes sample= for the clicked row', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: MOCK_SUMMARY }) })
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: MOCK_DETAIL, total: 2 }) })
    render(
      <GroupScaffoldModal
        members={[{ annotationId: 'COG0055', source: 'cog', name: 'foo' }]}
        groupLabel="Grouped terms"
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => screen.getByText(/Group totals/))
    // "COG0055" also appears in the member-list badge above the table —
    // only the second match is the actual table row (rows sort by date
    // ascending by default, so s1 at 05-10 08:00 sorts first).
    const rows = screen.getAllByText('COG0055')
    fireEvent.click(rows[1].closest('tr')!)
    await waitFor(() => {
      const url = mockFetch.mock.calls[1][0] as string
      expect(url).toContain('sample=s1')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldBtn
// ─────────────────────────────────────────────────────────────────────────────

describe('GroupScaffoldModal', () => {
  it('→ Explore all calls the grouped navigation handler with all members', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: MOCK_SUMMARY }),
    })

    const onClose = vi.fn()
    const onGoExploreGroup = vi.fn()

    render(
      <GroupScaffoldModal
        members={[
          { annotationId: 'COG0055', source: 'cog', name: 'foo' },
          { annotationId: 'K00001', source: 'kegg', name: 'bar' },
        ]}
        groupLabel="Grouped terms"
        onClose={onClose}
        onGoExploreGroup={onGoExploreGroup}
      />,
    )

    await waitFor(() => expect(screen.getByTestId('group-explore-btn')).toBeTruthy())
    fireEvent.click(screen.getByTestId('group-explore-btn'))

    expect(onGoExploreGroup).toHaveBeenCalledWith([
      { annotationId: 'COG0055', source: 'cog' },
      { annotationId: 'K00001', source: 'kegg' },
    ])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  function mockPartialFailure() {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('annotation_id=COG0055')) {
        return Promise.resolve({ ok: true, json: async () => ({ data: MOCK_SUMMARY }) })
      }
      return Promise.reject(new Error('Network error'))
    })
  }

  it('shows a warning when some members fail — does not silently drop them from totals', async () => {
    mockPartialFailure()
    render(
      <GroupScaffoldModal
        members={[
          { annotationId: 'COG0055', source: 'cog', name: 'foo' },
          { annotationId: 'K00001', source: 'kegg', name: 'bar' },
        ]}
        groupLabel="Grouped terms"
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('group-fetch-warning')).toBeTruthy()
    })
    expect(screen.getByTestId('group-fetch-warning').textContent).toContain('K00001')
  })

  it('partial-failure warning has a retry button', async () => {
    mockPartialFailure()
    render(
      <GroupScaffoldModal
        members={[
          { annotationId: 'COG0055', source: 'cog', name: 'foo' },
          { annotationId: 'K00001', source: 'kegg', name: 'bar' },
        ]}
        groupLabel="Grouped terms"
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('group-retry-btn')).toBeTruthy())
  })

  it('successful members still render their data despite one failure', async () => {
    mockPartialFailure()
    render(
      <GroupScaffoldModal
        members={[
          { annotationId: 'COG0055', source: 'cog', name: 'foo' },
          { annotationId: 'K00001', source: 'kegg', name: 'bar' },
        ]}
        groupLabel="Grouped terms"
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('3', { selector: '.scaffold-stat-val' })).toBeTruthy()
    })
  })

  it('no warning shown when all members succeed', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: MOCK_SUMMARY }) })
    render(
      <GroupScaffoldModal
        members={[
          { annotationId: 'COG0055', source: 'cog', name: 'foo' },
          { annotationId: 'K00001', source: 'kegg', name: 'bar' },
        ]}
        groupLabel="Grouped terms"
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => screen.getByText(/Group totals/))
    expect(screen.queryByTestId('group-fetch-warning')).toBeNull()
  })

  it('all members failing shows a distinct failed state, not "no data found"', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))
    render(
      <GroupScaffoldModal
        members={[
          { annotationId: 'COG0055', source: 'cog', name: 'foo' },
          { annotationId: 'K00001', source: 'kegg', name: 'bar' },
        ]}
        groupLabel="Grouped terms"
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('group-all-failed-state')).toBeTruthy()
    })
    expect(screen.queryByText('No scaffold data found for any annotation in this group.')).toBeNull()
  })

  it('genuinely empty result (all succeed, zero rows) still shows the plain empty state', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })
    render(
      <GroupScaffoldModal
        members={[{ annotationId: 'COG0055', source: 'cog', name: 'foo' }]}
        groupLabel="Grouped terms"
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('No scaffold data found for any annotation in this group.')).toBeTruthy()
    })
    expect(screen.queryByTestId('group-retry-btn')).toBeNull()
  })

  it('clicking retry re-fetches only the failed member and merges it in on success', async () => {
    mockPartialFailure()
    render(
      <GroupScaffoldModal
        members={[
          { annotationId: 'COG0055', source: 'cog', name: 'foo' },
          { annotationId: 'K00001', source: 'kegg', name: 'bar' },
        ]}
        groupLabel="Grouped terms"
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => screen.getByTestId('group-retry-btn'))

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('annotation_id=K00001')) {
        return Promise.resolve({ ok: true, json: async () => ({ data: MOCK_SUMMARY }) })
      }
      return Promise.reject(new Error('should not refetch the succeeded member'))
    })
    fireEvent.click(screen.getByTestId('group-retry-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('group-fetch-warning')).toBeNull()
    })
    // Both members now contributed identical MOCK_SUMMARY data, so the
    // scaffold total should double from 9 (one member) to 18 (both).
    expect(screen.getByText('18', { selector: '.scaffold-stat-val' })).toBeTruthy()
  })
})

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

  it('works with kegg source — fetches and renders normally, same as any source', async () => {
    mockApiSuccess({ data: MOCK_SUMMARY })
    render(<ScaffoldBtn annotationId="K02014" source="kegg" />)
    fireEvent.click(screen.getByTestId('scaffold-btn'))
    await waitFor(() => {
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('source=kegg')
    })
    await waitFor(() => {
      expect(screen.getByTestId('summary-table')).toBeTruthy()
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
