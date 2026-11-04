// ── App ───────────────────────────────────────────────────────────────────────
// Root component. Owns all cross-page state and renders the topbar, sidebar,
// and page mount points. All heavy logic lives in the page files.
//
// Pages are always mounted (display toggled via style) so their state, scroll
// position, and loaded data survive navigation without re-fetching.

import { useState, useEffect, useCallback } from 'react'

import type { Page, Theme, SharedAnnotation } from './types'
import { NAV_ITEMS, resetSourceCounters } from './constants'
import { apiFetch } from './utils/api'
import { ThemeToggle, ResetBtn } from './components/ui/controls'
import './App.css'
import { AnalyzePage } from './pages/AnalyzePage'
import { makeDefaultAnalyzeState, type AnalyzeHandoff, type AnalyzeState } from './pages/analyzeState'
import { bareTaxonName } from './utils/taxonomy'
import { ComparePage } from './pages/ComparePage'
import { makeDefaultCompareState, type CompareState } from './pages/compareState'
import { ExplorePage } from './pages/ExplorePage'
import { makeDefaultExploreState, type ExploreState } from './pages/exploreState'
import { TaxonomyPage } from './pages/TaxonomyPage'
import { makeDefaultTaxonomyState, type TaxonomyState } from './pages/taxonomyState'
import { AboutPage } from './pages/AboutPage'
import { MethodsPage } from './pages/MethodsPage'

export default function App() {
  // ── UI state ─────────────────────────────────────────────────────────
  const [page,        setPage]        = useState<Page>('analyze')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [theme,       setTheme]       = useState<Theme>('light')

  // ── API / index state ─────────────────────────────────────────────────
  const [apiOnline,     setApiOnline]     = useState<boolean | null>(null)
  const [indexReady,    setIndexReady]    = useState(false)
  const [dataDateRange, setDataDateRange] = useState<{ min: string; max: string } | null>(null)

  // ── Reset key — incrementing forces child panels to reset local state ─
  const [resetKey, setResetKey] = useState(0)

  // ── Cross-page navigation payloads ────────────────────────────────────
  const [pendingCompareAnns, setPendingCompareAnns] = useState<SharedAnnotation[]>([])

  // ── Per-page persistent state ─────────────────────────────────────────
  const [analyzeState, setAnalyzeStateRaw]   = useState<AnalyzeState>(makeDefaultAnalyzeState)
  const [exploreState, setExploreStateRaw]   = useState<ExploreState>(makeDefaultExploreState)
  const [compareState, setCompareStateRaw]   = useState<CompareState>(makeDefaultCompareState)
  const [taxonomyState, setTaxonomyStateRaw] = useState<TaxonomyState>(makeDefaultTaxonomyState)

  const setAnalyzeState = useCallback(
    (updater: (prev: AnalyzeState) => AnalyzeState) => setAnalyzeStateRaw(updater),
    [],
  )
  const setExploreState = useCallback(
    (updater: (prev: ExploreState) => ExploreState) => setExploreStateRaw(updater),
    [],
  )
  const setCompareState = useCallback(
    (updater: (prev: CompareState) => CompareState) => setCompareStateRaw(updater),
    [],
  )
  const setTaxonomyState = useCallback(
    (updater: (prev: TaxonomyState) => TaxonomyState) => setTaxonomyStateRaw(updater),
    [],
  )

  // ── Theme ─────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // ── API online check ─────────────────────────────────────────────────
  useEffect(() => {
    apiFetch<{ total: number }>('/api/timepoints?page_size=1')
      .then(() => setApiOnline(true))
      .catch(() => setApiOnline(false))
  }, [])

  // ── Index readiness polling ───────────────────────────────────────────
  // Poll /api/status every 2 seconds until the search index is built.
  // Also captures the dataset date range for constraining all date pickers.
  useEffect(() => {
    if (indexReady) return
    const check = () => {
      apiFetch<{ index_ready: boolean; date_min?: string; date_max?: string }>(
        '/api/status',
      )
        .then(r => {
          if (r.index_ready) setIndexReady(true)
          if (r.date_min && r.date_max) {
            const range = { min: r.date_min, max: r.date_max }
            setDataDateRange(prev => prev ?? range)
          }
        })
        .catch(() => {})
    }
    check()
    const interval = setInterval(check, 2000)
    return () => clearInterval(interval)
  }, [indexReady])

  // ── Reset ─────────────────────────────────────────────────────────────
  function handleReset() {
    setResetKey(k => k + 1)
    setAnalyzeStateRaw(makeDefaultAnalyzeState())
    setExploreStateRaw(makeDefaultExploreState())
    setCompareStateRaw(makeDefaultCompareState())
    setTaxonomyStateRaw(makeDefaultTaxonomyState())
    resetSourceCounters()
  }

  function handleResetAnalyze() {
    setAnalyzeStateRaw(makeDefaultAnalyzeState())
  }
  function handleResetExplore() {
    setResetKey(k => k + 1)
    setExploreStateRaw(makeDefaultExploreState())
  }
  function handleResetCompare() {
    setCompareStateRaw(makeDefaultCompareState())
  }
  function handleResetTaxonomy() {
    setTaxonomyStateRaw(makeDefaultTaxonomyState())
  }

  // ── Cross-page navigation ─────────────────────────────────────────────
  function handleSendToCompare(anns: SharedAnnotation[]) {
    setPendingCompareAnns(anns)
    setPage('compare')
  }

    function handleGoScaffoldExplore(annotationId: string, source: string) {
    const nonce = Date.now()
    setExploreState(prev => ({
      ...prev,
      openSection: 'scaffolds',
      // Include a nonce so ScaffoldExplorePanel's initialTermsKey changes
      // on every navigation — even for the same annotationId — ensuring
      // the useEffect re-fires correctly. O(1).
      scaffoldInitialTerms: [{ annotationId, source, _nonce: nonce }],
    }))
    setPage('explore')
  }

  function handleGoBulkDownload(lineage: string) {
    setExploreState(prev => ({
      ...prev,
      openSection: 'bulk-download',
      // A new object each time, so handing over the same taxon again still
      // applies after the user has changed it in the panel.
      bulkDownloadInitialParent: { lineage },
    }))
    setPage('explore')
  }

  function handleGoScaffoldExploreGroup(
    members: { annotationId: string; source: string }[],
  ) {
    const nonce = Date.now()
    setExploreState(prev => ({
      ...prev,
      openSection: 'scaffolds',
      scaffoldInitialTerms: members.map(m => ({
        annotationId: m.annotationId,
        source: m.source,
        _nonce: nonce,
      })),
    }))
    setPage('explore')
  }

  function handleSendToAnalyze(target: AnalyzeHandoff) {
    setAnalyzeState(prev => ({
      ...prev,
      // Something the search can find: a taxon is searched by its own name
      // (its id is the whole lineage), every other source by its id.
      queryFields:   [target.source === 'taxonomy' ? bareTaxonName(target.annotationId) : target.annotationId],
      openOnArrival: target,
      resultsByTerm: [],
      totalsByTerm:  [],
      searchStatus:  'idle',
      activeTermIdx: 0,
      checkedByTerm: {},
      autoRunSearch: true,
    }))
    setPage('analyze')
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Topbar ── */}
      <header className="topbar">
        <div className="topbar-brand">
          <button
            className="sidebar-toggle-btn"
            onClick={() => setSidebarOpen(o => !o)}
            title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
          <div className="logo-mark">
            <svg viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
              <path d="M9 4c4 4 4 6 0 10s-4 6 0 10" strokeWidth="1.6" />
              <path d="M21 4c-4 4-4 6 0 10s4 6 0 10" strokeWidth="1.6" />
              <path d="M10.3 7.5h9.4M9.3 15h11.4M10.3 22.5h9.4" strokeWidth="1.2" opacity=".8" />
            </svg>
          </div>
          <div className="brand-text">
            <span className="brand-name">Metatrace</span>
            <span className="brand-sub">Harmful Algal Bloom Metagenome Tracker</span>
          </div>
        </div>

        <div className="topbar-right">
          <ResetBtn onClick={handleReset} />
          <ThemeToggle
            theme={theme}
            onToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          />
          {!indexReady && apiOnline && (
            <div
              className="api-status loading"
              title="Search index is building — searches still work but may be slower"
            >
              <div className="dot" />
              <span>Building index…</span>
            </div>
          )}
          <div className={`api-status ${
            apiOnline === null ? 'loading' : apiOnline ? 'ok' : 'error'
          }`}>
            <div className="dot" />
            {apiOnline === null
              ? 'connecting…'
              : apiOnline
              ? 'API online'
              : 'API offline'}
          </div>
        </div>
      </header>

      {/* ── Sidebar ── */}
      <nav className={`sidebar ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
        {sidebarOpen && (
          <div className="sidebar-section">Navigation</div>
        )}
        {NAV_ITEMS.map(item => (
          <div
            key={item.id}
            className={[
              'nav-item',
              page === item.id ? 'active' : '',
              !sidebarOpen ? 'nav-item-icon-only' : '',
            ].join(' ')}
            onClick={() => setPage(item.id)}
            title={!sidebarOpen ? item.label : undefined}
          >
            <span
              className="nav-icon"
              dangerouslySetInnerHTML={{ __html: item.icon }}
            />
            {sidebarOpen && (
              <span className="nav-label">{item.label}</span>
            )}
          </div>
        ))}
        {sidebarOpen && (
          <div className="sidebar-footer">
            <p>128 metagenomic samples · JGI sequencing · HAB time series</p>
          </div>
        )}
      </nav>

      {/* ── Main content ── */}
      {/* All pages always mounted; display toggled so state never unmounts */}
      <main className="main">

        <div style={{
          display:       page === 'analyze' ? 'flex' : 'none',
          flexDirection: 'column',
          flex:          1,
        }}>
          <AnalyzePage
            state={analyzeState}
            setState={setAnalyzeState}
            indexReady={indexReady}
            dataDateRange={dataDateRange}
            onSendToCompare={handleSendToCompare}
            onGoScaffoldExplore={handleGoScaffoldExplore}
            onGoScaffoldExploreGroup={handleGoScaffoldExploreGroup}
            onReset={handleResetAnalyze}
          />
        </div>

        <div style={{ display: page === 'compare' ? 'block' : 'none' }}>
          <ComparePage
            state={compareState}
            setState={setCompareState}
            initialAnnotations={pendingCompareAnns}
            onConsumed={() => setPendingCompareAnns([])}
            dataDateRange={dataDateRange}
            onGoScaffoldExplore={handleGoScaffoldExplore}
            onGoScaffoldExploreGroup={handleGoScaffoldExploreGroup}
            onReset={handleResetCompare}
          />
        </div>

        <div style={{ display: page === 'explore' ? 'block' : 'none' }}>
          <ExplorePage
            state={exploreState}
            setState={setExploreState}
            resetKey={resetKey}
            dataDateRange={dataDateRange}
            indexReady={indexReady}
            onSendToAnalyze={handleSendToAnalyze}
            onGoScaffoldExplore={handleGoScaffoldExplore}
            onReset={handleResetExplore}
          />
        </div>

        <div style={{ display: page === 'taxonomy' ? 'block' : 'none' }}>
          <TaxonomyPage
            state={taxonomyState}
            setState={setTaxonomyState}
            dataDateRange={dataDateRange}
            onGoScaffoldExplore={handleGoScaffoldExplore}
            onGoBulkDownload={handleGoBulkDownload}
            onReset={handleResetTaxonomy}
          />
        </div>

        <div style={{ display: page === 'methods' ? 'block' : 'none' }}>
          <MethodsPage />
        </div>
        <div style={{ display: page === 'about' ? 'block' : 'none' }}>
          <AboutPage />
        </div>

      </main>
    </>
  )
}