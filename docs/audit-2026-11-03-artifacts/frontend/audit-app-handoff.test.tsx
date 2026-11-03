import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const TAXON = { annotation_id: 'Archaea;Euryarchaeota', source: 'taxonomy', name: 'Euryarchaeota', parent: 'Archaea', depth: 2, mean_egc: 1, max_egc: 1, sample_count: 128 }

// Emulates the real backend: taxonomy search matches on the bare `name`
// only (cache_sql.get_search_annotations), so a q that is a full lineage
// matches nothing (confirmed live: q=Archaea;Euryarchaeota -> total 0).
function setupMocks() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/timepoints')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ total: 128, data: [] }) })
    if (url.includes('/api/status')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ index_ready: true, date_min: '2021-05-01', date_max: '2021-06-30' }) })
    if (url.includes('/api/search/annotations')) {
      const q = decodeURIComponent(new URL(url, 'http://x').searchParams.get('q') ?? '')
      const hit = q.length >= 3 && !q.includes(';') && TAXON.name.toLowerCase().includes(q.toLowerCase())
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: hit ? [TAXON] : [], total: hit ? 1 : 0 }) })
    }
    if (url.includes('/api/series/annotations')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

let App: React.ComponentType
beforeEach(async () => { vi.clearAllMocks(); setupMocks(); App = (await import('/home/mriffle/dev/sophie-metatrace/HAB/frontend/src/App')).default })

describe('Explore lookup -> "View Timeseries in Analyze" for a taxonomy row', () => {
  it('lands on Analyze with the taxon found, not "No annotations found"', async () => {
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    await userEvent.click(await screen.findByText('Annotation Lookup', { selector: '.explore-card-label' }))
    await userEvent.selectOptions(screen.getByDisplayValue('kegg'), 'taxonomy')
    await userEvent.type(await screen.findByPlaceholderText(/ID \(K02014\)/i), 'Euryarchaeota')
    await userEvent.click(screen.getByRole('button', { name: /^Search$/i }))
    await waitFor(() => expect(document.querySelector('.lookup-result')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: /View Timeseries in Analyze/i }))
    await waitFor(() => {
      const nav = screen.getByText('Analyze', { selector: '.nav-label' }).closest('.nav-item')
      expect(nav).toHaveClass('active')
    })
    await waitFor(() => expect(mockFetch.mock.calls.some(([u]) => String(u).includes('/api/search/annotations?q='))).toBe(true))
    const analyzeCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter(u => u.includes('page_size=5000'))
    console.log('Analyze search URL:', analyzeCalls)
    await waitFor(() => {
      expect(screen.queryByText(/No annotations found/i)).not.toBeInTheDocument()
      expect(document.querySelector('.al-row-name')?.textContent).toContain('Euryarchaeota')
    })
  })
})
