import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceArea, Brush,
} from 'recharts'
import './App.css'

// ── Error Boundary ─────────────────────────────────────────────────────────
// Wraps each chart card so one broken chart cannot crash the whole app.

class ChartErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode; label?: string }) {
    super(props)
    this.state = { hasError: false, message: '' }
  }
  static getDerivedStateFromError(err: Error) {
    return { hasError: true, message: err.message }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="state-box error" style={{ padding: '20px', borderRadius: 8 }}>
          <div className="state-icon">⚠</div>
          <span>
            Chart failed to render{this.props.label ? ` (${this.props.label})` : ''}.
            {' '}<span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)' }}>
              {this.state.message}
            </span>
          </span>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

type TimepointMeta = { taxon_oid: string; timepoint: string; datetime: string }
type AnnotationItem = {
  source: string; sample: string
  timepoint: TimepointMeta | null
  annotation_id: string; name: string | null; value: unknown
  mean_egc?: number | null; max_egc?: number | null; sample_count?: number | null
}
type MappingRow = {
  gene_id: string | null; contig_id: string | null
  taxonomy: string | null; kegg_id: string | null
  enzyme: string | null; cog_id: string | null
}
type MappingSearchRow = MappingRow & { sample: string; timepoint: TimepointMeta | null }
type TopAnnotation = {
  annotation_id: string; name: string | null; parent: string | null
  mean_egc: number; max_egc: number; sample_count: number
}
type ApiStatus = 'idle' | 'loading' | 'ok' | 'error'
type Page = 'analyze' | 'compare' | 'explore' | 'about'
type SortDir = 'asc' | 'desc'
type Theme = 'dark' | 'light'
type UiMode = 'basic' | 'advanced'
 
type ScaffoldSummaryRow = {
  sample:         string
  date:           string
  scaffold_count: number
  gene_count:     number
}
 
type ScaffoldDetailRow = {
  sample:   string
  date:     string
  scaffold: string
  count:    number
}
type CorrelateResult = {
  annotation_id: string; source: string; name: string | null; parent: string | null
  spearman_r: number; abs_r: number; lag_samples: number; lag_hours: number
  p_value: number | null; n_pairs: number
}

const SOURCE_COLORS: Record<string, string> = {
  kegg: 'var(--chart-1)', cog: 'var(--chart-2)',
  enzyme: 'var(--chart-3)', taxonomy: 'var(--chart-4)',
}
const SOURCE_TAG_CLS: Record<string, string> = {
  kegg: 'teal', cog: 'violet', enzyme: 'amber', taxonomy: 'coral',
}
const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)']

const SOURCE_SHADES: Record<string, string[]> = {
  kegg:     ['#38d9b4', '#0c9e7a', '#8effe0', '#1ecfaa'],
  cog:      ['#7b8ef0', '#3d4fc8', '#b3bbff', '#5566ff'],
  enzyme:   ['#f0b429', '#b87900', '#ffd97a', '#e09000'],
  taxonomy: ['#e8705a', '#b03520', '#ffaa95', '#cc4430'],
}
const _sourceCounters: Record<string, number> = {}

function nextColorForSource(source: string): string {
  const shades = SOURCE_SHADES[source] ?? CHART_COLORS
  const idx = (_sourceCounters[source] ?? 0) % shades.length
  _sourceCounters[source] = idx + 1
  return shades[idx]
}

function resetSourceCounters() {
  for (const key of Object.keys(_sourceCounters)) {
    _sourceCounters[key] = 0
  }
}

// ── Biological label lookups ───────────────────────────────────────────────

const COG_CATEGORY_LABELS: Record<string, string> = {
  A: 'RNA processing and modification',
  B: 'Chromatin structure and dynamics',
  C: 'Energy production and conversion',
  D: 'Cell cycle control, division, chromosome partitioning',
  E: 'Amino acid transport and metabolism',
  F: 'Nucleotide transport and metabolism',
  G: 'Carbohydrate transport and metabolism',
  H: 'Coenzyme transport and metabolism',
  I: 'Lipid transport and metabolism',
  J: 'Translation, ribosomal structure and biogenesis',
  K: 'Transcription',
  L: 'Replication, recombination and repair',
  M: 'Cell wall/membrane/envelope biogenesis',
  N: 'Cell motility',
  O: 'Posttranslational modification, protein turnover, chaperones',
  P: 'Inorganic ion transport and metabolism',
  Q: 'Secondary metabolites biosynthesis, transport, catabolism',
  R: 'General function prediction only',
  S: 'Function unknown',
  T: 'Signal transduction mechanisms',
  U: 'Intracellular trafficking, secretion, vesicular transport',
  V: 'Defense mechanisms',
  W: 'Extracellular structures',
  X: 'Mobilome: prophages, transposons',
  Y: 'Nuclear structure',
  Z: 'Cytoskeleton',
}

const ENZYME_CLASS_LABELS: Record<string, string> = {
  '1': 'Oxidoreductases',
  '2': 'Transferases',
  '3': 'Hydrolases',
  '4': 'Lyases',
  '5': 'Isomerases',
  '6': 'Ligases',
  '7': 'Translocases',
}

// KEGG BRITE top-level numeric category codes → human labels
// These appear as parent values when the BRITE hierarchy stores only the code.
const KEGG_BRITE_CODES: Record<string, string> = {
  '00001': 'KEGG Orthology (KO)',
  '00002': 'KEGG Pathway',
  '00003': 'KEGG Module',
  '00004': 'KEGG Network',
  '99976': 'Unclassified metabolism',
  '99977': 'Unclassified cellular processes',
  '99978': 'Unclassified genetic information processing',
  '99979': 'Unclassified environmental information processing',
  '99980': 'Unclassified signaling/cellular processes',
  '99981': 'Function unknown',
  '99982': 'Unclassified',
  '99983': 'Unclassified protein families',
  '99984': 'Unclassified poorly characterized',
  '99985': 'Other ion-coupled transporters',
  '99986': 'Other transporters',
  '99987': 'Other electron carriers',
  '99988': 'Other enzymes',
  '99990': 'Miscellaneous',
  '99995': 'Not included in regular maps',
  '99996': 'Not included in regular maps',
  '99997': 'Unclassified: metabolism',
  '99998': 'Unclassified: genetic information processing',
  '99999': 'Unclassified: cellular processes',
  '02024': 'Transporters',
  '02000': 'Transporters',
  '02044': 'Secretion system',
  '02048': 'Prokaryotic defense system',
  '01000': 'Enzymes',
  '01001': 'Protein kinases',
  '01002': 'Peptidases and inhibitors',
  '01003': 'Glycosyltransferases',
  '01004': 'Lipid biosynthesis proteins',
  '01005': 'Lipopolysaccharide biosynthesis proteins',
  '01007': 'Amino acid related enzymes',
  '01008': 'Polyketide biosynthesis proteins',
  '01009': 'Protein phosphatases and associated proteins',
  '01010': 'Ribosome biogenesis',
  '01011': 'Peptide antibiotics',
  '01012': 'Ubiquitin system',
}

function expandParentLabel(parent: string, source: string): string {
  if (!parent) return parent
  if (source === 'cog') {
    const key = parent.trim().toUpperCase()
    return COG_CATEGORY_LABELS[key] ? `${key} · ${COG_CATEGORY_LABELS[key]}` : parent
  }
  if (source === 'enzyme') {
    const cls = parent.trim().split('.')[0]
    return ENZYME_CLASS_LABELS[cls] ? `${parent} · ${ENZYME_CLASS_LABELS[cls]}` : parent
  }
  if (source === 'kegg') {
    // Format: "12345 Some label" — strip leading 5-digit code
    const withoutCode = parent.replace(/^\d{5}\s+/, '').trim()
    if (withoutCode && withoutCode !== parent) return withoutCode

    // Pure numeric code with no label — look up in BRITE table
    const codeOnly = parent.trim()
    if (/^\d{5}$/.test(codeOnly)) {
      return KEGG_BRITE_CODES[codeOnly]
        ? `${KEGG_BRITE_CODES[codeOnly]}`
        : `BRITE group ${codeOnly}`
    }
    return parent
  }
  return parent
}

function computeTrend(egcValues: number[]): number | null {
  if (egcValues.length < 4) return null
  const q = Math.floor(egcValues.length / 4)
  const firstQ = egcValues.slice(0, q)
  const lastQ = egcValues.slice(-q)
  const meanFirst = firstQ.reduce((a, b) => a + b, 0) / firstQ.length
  const meanLast = lastQ.reduce((a, b) => a + b, 0) / lastQ.length
  return meanLast - meanFirst
}

const FETCH_TIMEOUT_MS = 30_000

async function apiFetch<T>(path: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(path, { signal: controller.signal })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json() as Promise<T>
  } finally {
    clearTimeout(timer)
  }
}

function extractEgc(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.egc === 'number') return v.egc
    if (typeof v.EGC === 'number') return v.EGC
  }
  return null
}

/**
 * Extract the pre-computed norm_egc field from an annotation value.
 * norm_egc = egc / total_sample_depth — already depth-normalised by the pipeline.
 * Used by L1 mode so the chart shows true relative abundance without
 * re-dividing by the (arbitrary) series total.
 */
function extractNormEgc(value: unknown): number | null {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.norm_egc === 'number') return v.norm_egc
    if (typeof v.NORM_EGC === 'number') return v.NORM_EGC
  }
  return null
}

function parseDateTime(dt: string): number {
  if (!dt) return 0
  const d = new Date(dt)
  if (!isNaN(d.getTime())) return d.getTime()
  const parts = dt.split(' ')
  const dateParts = parts[0].split('/')
  if (dateParts.length === 3) {
    const [m, day, yr] = dateParts
    const fullYr = Number(yr) < 100 ? 2000 + Number(yr) : Number(yr)
    const timeParts = (parts[1] ?? '00:00').split(':')
    return new Date(
      fullYr,
      Number(m) - 1,
      Number(day),
      Number(timeParts[0] ?? 0),
      Number(timeParts[1] ?? 0)
    ).getTime()
  }
  return 0
}

function fmtDate(dt: string): string {
  if (!dt) return ''
  const d = new Date(dt)
  if (isNaN(d.getTime())) return dt.split(' ')[0]
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const yr = String(d.getFullYear()).slice(2)
  return `${m}/${day}/${yr}`
}
function fmtTime(dt: string): string {
  if (!dt) return ''
  const d = new Date(dt)
  if (isNaN(d.getTime())) {
    // Try parsing "MM/DD/YY HH:MM" format
    const parts = dt.split(' ')
    return parts[1] ?? ''
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Given a sorted list of points with a datetime field, compute ReferenceArea
 * bands for alternating day shading. Even-indexed days get a subtle fill;
 * odd-indexed days are transparent.
 *
 * Returns array of { x1, x2, shade } where x1/x2 are datetime strings
 * (full "MM/DD/YY HH:MM" values that exist in the data domain) and
 * shade is true for days that should be filled.
 */
function computeDayBands(
  points: { datetime: string }[]
): { x1: string; x2: string; shade: boolean }[] {
  if (points.length < 2) return []

  // Group consecutive points by calendar date (MM/DD/YY portion)
  const dayGroups: { date: string; points: { datetime: string }[] }[] = []
  for (const pt of points) {
    const day = pt.datetime.split(' ')[0] ?? ''
    const last = dayGroups[dayGroups.length - 1]
    if (last && last.date === day) {
      last.points.push(pt)
    } else {
      dayGroups.push({ date: day, points: [pt] })
    }
  }

  return dayGroups.map((group, i) => ({
    x1:    group.points[0].datetime,
    x2:    group.points[group.points.length - 1].datetime,
    shade: i % 2 === 0,
  }))
}

/**
 * Context-aware XAxis tick formatter for EgcChart.
 * - Wide view (> 2 days): show MM/DD only on the first timepoint of each day
 * - Zoomed view (≤ 2 days): show HH:MM for each timepoint
 * Returns empty string for ticks that should be blank to avoid clutter.
 */
function makeTickFormatter(
  points: { datetime: string }[],
  uniqueDayCount: number
): (value: string) => string {
  if (uniqueDayCount > 2) {
    // Wide view — show date on first occurrence of each day only
    const seenDays = new Set<string>()
    const firstOfDay = new Set<string>()
    for (const pt of points) {
      const day = pt.datetime.split(' ')[0] ?? ''
      if (!seenDays.has(day)) {
        seenDays.add(day)
        firstOfDay.add(pt.datetime)
      }
    }
    return (value: string) => {
      if (!firstOfDay.has(value)) return ''
      const day = value.split(' ')[0] ?? ''
      // Convert MM/DD/YY → MM/DD for display
      const parts = day.split('/')
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : day
    }
  } else {
    // Zoomed view — show HH:MM for each point
    return (value: string) => {
      const time = value.split(' ')[1] ?? ''
      return time
    }
  }
}
function isoDate(dt: string): string {
  if (!dt) return ''
  const d = new Date(dt)
  if (isNaN(d.getTime())) return dt.slice(0, 10)
  return d.toISOString().slice(0, 10)
}

function downloadCsv(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return
  const cols = Object.keys(rows[0])
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ── External database links ────────────────────────────────────────────────
// Returns clickable links to source databases for a given annotation ID.
// Opens in new tab, never disrupts the portal.

function externalLinks(annotationId: string, source: string): React.ReactNode {
  const id = annotationId.trim()
  if (!id) return null

  const link = (href: string, label: string, title: string) => (
    <a
      key={label}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="ext-link"
      title={title}
      onClick={e => e.stopPropagation()}
    >
      {label}
    </a>
  )

  if (source === 'kegg') {
    // KEGG IDs: K12345 (orthology), C12345 (compound), R12345 (reaction), map12345 (pathway)
    const isKO = /^K\d{5}$/.test(id)
    const links: React.ReactNode[] = []
    if (isKO) {
      links.push(link(
        `https://www.genome.jp/entry/${id}`,
        'KEGG', 'KEGG Orthology entry'
      ))
      links.push(link(
        `https://www.genome.jp/kegg-bin/show_brite?htext=ko00001.keg&query=${id}`,
        'BRITE', 'Find in KEGG BRITE functional hierarchy'
      ))
      // Color Mapper: copy ID to clipboard then open — user just pastes into the Objects box
      links.push(
        <button
          key="mapper"
          className="ext-link"
          title={`Copy ${id} to clipboard then open KEGG Color Mapper — paste into the Objects box`}
          onClick={async (e) => {
            e.stopPropagation()
            try { await navigator.clipboard.writeText(id) } catch {}
            window.open('https://www.genome.jp/kegg/mapper/color.html', '_blank', 'noopener')
          }}
        >
          Color Mapper ⎘
        </button>
      )
    } else {
      links.push(link(`https://www.genome.jp/entry/${id}`, 'KEGG', 'KEGG database entry'))
    }
    return <>{links}</>
  }

  if (source === 'cog') {
    // COG IDs: COG1234
    return link(
      `https://www.ncbi.nlm.nih.gov/research/cog/cog/${id}/`,
      'NCBI COG', 'NCBI COG database entry'
    )
  }

  if (source === 'enzyme') {
    // EC numbers: 1.1.1.1 or EC:1.1.1.1
    const ec = id.replace(/^EC:/i, '')
    return <>
      {link(
        `https://www.genome.jp/entry/ec:${ec}`,
        'KEGG',
        'KEGG ENZYME entry'
      )}
      {link(
        `https://www.ncbi.nlm.nih.gov/enzyme/?term=${encodeURIComponent(ec)}`,
        'NCBI',
        'NCBI Enzyme search'
      )}
    </>
  }

  if (source === 'taxonomy') {
    // Taxonomy: search by name
    const q = encodeURIComponent(id)
    return link(
      `https://www.ncbi.nlm.nih.gov/taxonomy/?term=${q}`,
      'NCBI Taxonomy', 'Search NCBI Taxonomy'
    )
  }

  return null
}

// Inline version — ID as link + small external link badges beside it
function externalLink(annotationId: string, source: string): React.ReactNode {
  const links = externalLinks(annotationId, source)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--teal)', fontWeight: 600 }}>
        {annotationId}
      </span>
      {links}
    </span>
  )
}
//
// Root cause of persistent darkness: getComputedStyle returns rgb(0,0,0)
// for SVG elements that have no CSS rule — browser default. Recharts sets
// colors as element *attributes* (stroke="#38d9b4"), not CSS. So we must
// read getAttribute first, then fall back to computed style as a last resort.
// We also strip the cloned SVG root's style="" so it cannot override bgRect.
function downloadChartPng(
  containerRef: React.RefObject<HTMLDivElement>,
  filename: string,
  title?: string
) {
  const node = containerRef.current
  if (!node) return
  const svg = node.querySelector('svg')
  if (!svg) return

  const BG_COLOR   = '#ffffff'
  const TEXT_COLOR = '#1e293b'
  const GRID_COLOR = '#e2e8f0eb'
  const AXIS_COLOR = '#94a3b8'
  const DIM_COLOR  = '#64748b'

  const { width, height } = svg.getBoundingClientRect()
  const TITLE_H = title ? 40 : 0
  const PADDING = 20
  const canvasW = width  + PADDING * 2
  const canvasH = height + PADDING * 2 + TITLE_H

  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('width',  String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns',  'http://www.w3.org/2000/svg')
  // Strip any inline style on the SVG root (Recharts sets background via style)
  clone.removeAttribute('style')

  // White background rect — inserted first so it is behind all chart elements
  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bgRect.setAttribute('x', '0')
  bgRect.setAttribute('y', '0')
  bgRect.setAttribute('width',  String(width))
  bgRect.setAttribute('height', String(height))
  bgRect.setAttribute('fill',   BG_COLOR)
  clone.insertBefore(bgRect, clone.firstChild)

  // Resolve CSS variables to concrete hex values
  const cssVarCache: Record<string, string> = {}
  function resolveCssVar(val: string): string {
    if (!val || !val.includes('var(')) return val
    return val.replace(/var\(([^)]+)\)/g, (_, name) => {
      const k = name.trim()
      if (!cssVarCache[k]) {
        cssVarCache[k] = getComputedStyle(document.documentElement).getPropertyValue(k).trim()
      }
      return cssVarCache[k] || '#888888'
    })
  }

  // Resolve a color property for one element.
  // Priority: explicit attribute → computed style → fallback
  function resolveAttrColor(liveEl: Element, prop: 'fill' | 'stroke'): string | null {
    // 1. Explicit attribute (how Recharts sets line/dot colors)
    const attr = liveEl.getAttribute(prop)
    if (attr && attr !== 'none' && attr !== 'transparent') {
      return resolveCssVar(attr)
    }
    // 2. Inline style property
    const styleVal = (liveEl as HTMLElement).style?.[prop as 'fill' | 'stroke']
    if (styleVal && styleVal !== 'none') {
      return resolveCssVar(styleVal)
    }
    // 3. Computed style — only trust it if it's not the browser default black
    const computed = window.getComputedStyle(liveEl)
    const cv = prop === 'fill' ? computed.fill : computed.stroke
    if (cv && cv !== 'rgb(0, 0, 0)' && cv !== 'rgba(0, 0, 0, 0)' && cv !== 'none') {
      return resolveCssVar(cv)
    }
    return null
  }

  // Walk live elements and inline resolved colors onto clone counterparts.
  // We select only concrete SVG drawing elements (not containers like <g> or <svg>)
  // so that any nested <svg> elements Recharts might add cannot cause index drift.
  // querySelectorAll on both trees in the same order guarantees 1:1 alignment.
  const SVG_DRAWABLE = 'path, line, polyline, polygon, rect, circle, ellipse, text, tspan'
  const liveEls  = Array.from(svg.querySelectorAll(SVG_DRAWABLE))   as Element[]
  const cloneEls = Array.from(clone.querySelectorAll(SVG_DRAWABLE)) as SVGElement[]
  // bgRect IS a rect in clone and will appear in cloneEls — we must skip it.
  // We align live SVG rects to clone rects by walking liveEls against
  // cloneEls[i + 1] to account for the inserted bgRect at index 0.
  // All other rects are Recharts background elements — strip their fills.
  const bgRectOffset = 1  // bgRect sits at cloneEls[0]; live SVG rects start at cloneEls[1]

  liveEls.forEach((liveEl, i) => {
    const cloneEl = cloneEls[i + bgRectOffset]
    if (!cloneEl) return

    const tag = liveEl.tagName.toLowerCase()
    const cls = liveEl.getAttribute('class') ?? ''

    // Strip fill from ALL rect elements — Recharts uses rects only for backgrounds.
    // Data dots are circles; lines are paths. Safe to nuke all rect fills.
    if (tag === 'rect') {
      cloneEl.setAttribute('fill', 'none')
      cloneEl.setAttribute('stroke', 'none')
      return
    }

    // Text elements — always force to dark readable color
    if (tag === 'text' || tag === 'tspan') {
      const computed = window.getComputedStyle(liveEl)
      cloneEl.setAttribute('fill',        TEXT_COLOR)
      cloneEl.setAttribute('stroke',      'none')
      cloneEl.setAttribute('font-family', 'monospace')
      cloneEl.setAttribute('font-size',   computed.fontSize || '11px')
      return
    }

    // Grid lines
    if (cls.includes('recharts-cartesian-grid')) {
      cloneEl.setAttribute('stroke', GRID_COLOR)
      cloneEl.setAttribute('fill',   'none')
      return
    }

    // Axis lines and ticks
    if (cls.includes('recharts-cartesian-axis') || cls.includes('recharts-xAxis') || cls.includes('recharts-yAxis')) {
      const fill   = resolveAttrColor(liveEl, 'fill')
      const stroke = resolveAttrColor(liveEl, 'stroke')
      cloneEl.setAttribute('fill',   fill   ?? DIM_COLOR)
      cloneEl.setAttribute('stroke', stroke ?? AXIS_COLOR)
      return
    }

    // All other elements — resolve fill and stroke from attributes
    const fill   = resolveAttrColor(liveEl, 'fill')
    const stroke = resolveAttrColor(liveEl, 'stroke')

    // Strip any path fill that is not 'none' and has no stroke —
    // these are background/area fill paths, not data lines.
    // Data line paths always have a stroke color set explicitly by Recharts.
    const fillOpacity = liveEl.getAttribute('fill-opacity')
    const isAreaFill  = tag === 'path' && (
      (fillOpacity !== null && parseFloat(fillOpacity) < 1) ||
      (fill && fill !== 'none' && (!stroke || stroke === 'none'))
    )
    if (isAreaFill) {
      cloneEl.setAttribute('fill', 'none')
      cloneEl.removeAttribute('fill-opacity')
      if (stroke) cloneEl.setAttribute('stroke', stroke)
    } else {
      if (fill)   cloneEl.setAttribute('fill',   fill)
      if (stroke) cloneEl.setAttribute('stroke', stroke)
    }
    // Remove any inline style that might carry dark background colors
    cloneEl.removeAttribute('style')
    // Remove any inline style that might carry dark background colors
    cloneEl.removeAttribute('style')
  })

  // Serialize to base64 data URI — avoids blob URL CORS/timing issues
  const svgData = new XMLSerializer().serializeToString(clone)
  const svgB64  = btoa(unescape(encodeURIComponent(svgData)))
  const dataUri = `data:image/svg+xml;base64,${svgB64}`
  const img     = new Image()

  img.onload = () => {
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width  = canvasW * scale
    canvas.height = canvasH * scale
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)

    ctx.fillStyle = BG_COLOR
    ctx.fillRect(0, 0, canvasW, canvasH)

    if (title) {
      ctx.fillStyle = TEXT_COLOR
      ctx.font      = `600 13px 'IBM Plex Mono', monospace`
      ctx.textAlign = 'left'
      ctx.fillText(title, PADDING, PADDING + 18)
    }

    ctx.drawImage(img, PADDING, PADDING + TITLE_H, width, height)

    const a = document.createElement('a')
    a.download = filename
    a.href     = canvas.toDataURL('image/png')
    a.click()
  }
  img.onerror = (e) => console.error('PNG export failed:', e)
  img.src = dataUri
}

/**
 * Export the chart SVG directly as an .svg file with white background.
 */
function downloadChartSvg(
  containerRef: React.RefObject<HTMLDivElement>,
  filename: string,
  title?: string
) {
  const node = containerRef.current
  if (!node) return
  const svg = node.querySelector('svg')
  if (!svg) return

  const BG_COLOR   = '#ffffff'
  const TEXT_COLOR = '#1e293b'
  const GRID_COLOR = '#e2e8f0'
  const AXIS_COLOR = '#94a3b8'

  const { width, height } = svg.getBoundingClientRect()
  const TITLE_H = title ? 28 : 0
  const PADDING = 16
  const totalW  = width  + PADDING * 2
  const totalH  = height + PADDING * 2 + TITLE_H

  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('width', String(totalW))
  clone.setAttribute('height', String(totalH))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.removeAttribute('style')

  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bgRect.setAttribute('x', '0'); bgRect.setAttribute('y', '0')
  bgRect.setAttribute('width', String(totalW)); bgRect.setAttribute('height', String(totalH))
  bgRect.setAttribute('fill', BG_COLOR)
  clone.insertBefore(bgRect, clone.firstChild)

  if (title) {
    const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    titleEl.setAttribute('x', String(PADDING))
    titleEl.setAttribute('y', String(PADDING + 16))
    titleEl.setAttribute('fill', TEXT_COLOR)
    titleEl.setAttribute('font-family', "'IBM Plex Mono', monospace")
    titleEl.setAttribute('font-size', '12')
    titleEl.setAttribute('font-weight', '600')
    titleEl.textContent = title
    clone.insertBefore(titleEl, clone.children[1])
  }

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  g.setAttribute('transform', `translate(${PADDING}, ${PADDING + TITLE_H})`)
  const offset = title ? 2 : 1
  while (clone.children.length > offset) g.appendChild(clone.children[offset])
  clone.appendChild(g)

  clone.querySelectorAll('[stroke]').forEach(el => {
    const s = el.getAttribute('stroke') ?? ''
    if (s.includes('var(--border)'))   el.setAttribute('stroke', GRID_COLOR)
    if (s.includes('var(--text-dim)')) el.setAttribute('stroke', AXIS_COLOR)
  })
  clone.querySelectorAll('text').forEach(el => {
    if ((el.getAttribute('fill') ?? '').includes('var(')) el.setAttribute('fill', TEXT_COLOR)
  })

  const svgData = new XMLSerializer().serializeToString(clone)
  const blob    = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
  const url     = URL.createObjectURL(blob)
  const a       = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ── Signal Processing ──────────────────────────────────────────────────────

function buildTimepointTotals(
  allSeries: { data: AnnotationItem[] }[]
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const s of allSeries) {
    for (const d of s.data) {
      const dt = d.timepoint?.datetime ?? ''
      if (!dt) continue
      const egc = extractEgc(d.value)
      if (egc === null) continue
      totals.set(dt, (totals.get(dt) ?? 0) + egc)
    }
  }
  return totals
}

function applyL1Normalize(
  data: { egc: number | null; datetime?: string }[],
  timepointTotals?: Map<string, number>
): { egc: number | null; datetime?: string }[] {
  if (timepointTotals && timepointTotals.size > 0) {
    return data.map(d => {
      if (d.egc === null) return d
      const total = d.datetime ? (timepointTotals.get(d.datetime) ?? 0) : 0
      return { ...d, egc: total > 0 ? d.egc / total : null }
    })
  }
  const total = data.reduce((s, d) => s + (d.egc ?? 0), 0)
  if (total === 0) return data
  return data.map(d => ({ ...d, egc: d.egc !== null ? d.egc / total : null }))
}

/**
 * Z-score standardization per series.
 * Subtracts the series mean and divides by std dev.
 * Result: all series centered at 0, scaled by variance.
 * Best for visual comparison of trends across wildly different EGC scales.
 * Returns null for points where std dev = 0 (flat series).
 */
function applyZScore(
  data: { egc: number | null }[]
): { egc: number | null }[] {
  const vals = data.map(d => d.egc).filter((v): v is number => v !== null)
  if (vals.length < 2) return data
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const std  = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
  if (std === 0) return data.map(d => ({ ...d, egc: d.egc !== null ? 0 : null }))
  return data.map(d => ({ ...d, egc: d.egc !== null ? (d.egc - mean) / std : null }))
}
function applyLowess(
  data: { egc: number | null }[],
  bandwidth: number
): { egc: number | null }[] {
  const pts = data
    .map((d, i) => ({ i, x: i, y: d.egc }))
    .filter(p => p.y !== null) as { i: number; x: number; y: number }[]
  if (pts.length < 3) return data

  const n    = pts.length
  const span = Math.max(2, Math.ceil(bandwidth * n))
  const smoothed = new Map<number, number>()

  for (const pt of pts) {
    const dists = pts.map(p => ({ p, d: Math.abs(p.x - pt.x) }))
    dists.sort((a, b) => a.d - b.d)
    const neighbors = dists.slice(0, span)
    const maxDist   = neighbors[neighbors.length - 1].d || 1

    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0
    for (const { p, d } of neighbors) {
      const u = d / maxDist
      const w = Math.pow(1 - Math.pow(u, 3), 3)
      sw += w; swx += w * p.x; swy += w * p.y
      swxx += w * p.x * p.x; swxy += w * p.x * p.y
    }
    const denom = sw * swxx - swx * swx
    const b = denom !== 0 ? (sw * swxy - swx * swy) / denom : 0
    const a = (swy - b * swx) / sw
    smoothed.set(pt.i, a + b * pt.x)
  }

  return data.map((d, i) => ({
    ...d,
    egc: smoothed.has(i) ? smoothed.get(i)! : d.egc,
  }))
}

// ── Descriptive Statistics ─────────────────────────────────────────────────

type DescStats = {
  n: number; mean: number; median: number; std: number
  min: number; max: number; q1: number; q3: number; cv: number
}

/**
 * Compute descriptive statistics on a sorted array of values.
 *
 * Std dev: sample (÷ n-1), Bessel-corrected. Labelled "s" in the UI to
 * distinguish from population σ. For this time series the 128 samples
 * are observational draws from a process, not the full population.
 *
 * Q1/Q3: linear interpolation (Type 7, the R and numpy default).
 * At index h = (n-1)*p, value = sorted[floor(h)] + frac(h)*(sorted[ceil(h)] - sorted[floor(h)]).
 * This matches what researchers will get from R's quantile() or numpy.percentile().
 */
function computeStats(vals: number[]): DescStats | null {
  if (vals.length === 0) return null
  const sorted = [...vals].sort((a, b) => a - b)
  const n      = sorted.length
  const mean   = sorted.reduce((a, b) => a + b, 0) / n

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)]

  // Sample std dev — divide by (n-1)
  const std = n > 1
    ? Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
    : 0

  // Type 7 linear interpolation for quartiles
  function quantile(p: number): number {
    const h    = (n - 1) * p
    const lo   = Math.floor(h)
    const hi   = Math.ceil(h)
    const frac = h - lo
    return lo === hi ? sorted[lo] : sorted[lo] + frac * (sorted[hi] - sorted[lo])
  }
  const q1 = quantile(0.25)
  const q3 = quantile(0.75)

  return { n, mean, median, std, min: sorted[0], max: sorted[n - 1], q1, q3, cv: mean !== 0 ? std / mean : 0 }
}

function StatsPanel({ vals, yLabel }: { vals: number[]; yLabel: string }) {
  const stats = useMemo(() => computeStats(vals), [vals])
  if (!stats) return null
  const fmt = (v: number) => Math.abs(v) < 0.01 || Math.abs(v) > 9999
    ? v.toExponential(3) : v.toPrecision(4)
  const rows: [string, string][] = [
    ['n',        String(stats.n)],
    ['Mean',     fmt(stats.mean)],
    ['Median',   fmt(stats.median)],
    ['Std Dev s', fmt(stats.std)],   // 's' = sample std dev ÷(n-1), not population σ
    ['CV',       (stats.cv * 100).toFixed(1) + '%'],
    ['Min',      fmt(stats.min)],
    ['Q1',       fmt(stats.q1)],
    ['Q3',       fmt(stats.q3)],
    ['Max',      fmt(stats.max)],
  ]
  return (
    <div className="stats-panel">
      <div className="stats-panel-title">Descriptive Statistics · {yLabel}</div>
      <div className="stats-grid">
        {rows.map(([label, value]) => (
          <div className="stat-cell" key={label}>
            <span className="stat-cell-label">{label}</span>
            <span className="stat-cell-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Copy ID Button ─────────────────────────────────────────────────────────

function useCopyId() {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copy = useCallback((id: string) => {
    navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    })
  }, [])
  return { copiedId, copy }
}

function CopyBtn({ id, copiedId, onCopy }: {
  id: string; copiedId: string | null; onCopy: (id: string) => void
}) {
  const copied = copiedId === id
  return (
    <button
      className="copy-btn"
      title="Copy annotation ID"
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); onCopy(id) }}
    >
      {copied ? '✓' : '⎘'}
    </button>
  )
}

function AdvancedOnly({ mode, children }: { mode: UiMode; children: React.ReactNode }) {
    if (mode === 'basic') return null
    return <>{children}</>
  }
 
  function ModeToggle({ mode, onToggle }: { mode: UiMode; onToggle: () => void }) {
    return (
      <button className="mode-toggle" onClick={onToggle}
        title={mode === 'basic'
          ? 'Switch to Advanced — unlocks normalization, smoothing, correlates, and mappings'
          : 'Switch to Basic — hides advanced analysis tools'}>
        <span className={`mode-toggle-pill ${mode === 'basic' ? 'active' : ''}`}>Basic</span>
        <span className={`mode-toggle-pill ${mode === 'advanced' ? 'active' : ''}`}>Advanced</span>
      </button>
    )
  }
 
  function FirstRunHint({ uiMode }: { uiMode: UiMode }) {
    return (
      <div className="first-run-hint">
        <div className="frh-steps">
          <div className="frh-step">
            <div className="frh-step-num">1</div>
            <div className="frh-step-text">
              <strong>Search</strong> for a gene function — try <em>iron transport</em>, <em>COG0055</em>, or <em>photosynthesis</em>
            </div>
          </div>
          <div className="frh-step">
            <div className="frh-step-num">2</div>
            <div className="frh-step-text">
              <strong>Click +</strong> on any result to add its time series chart to the right panel
            </div>
          </div>
          <div className="frh-step">
            <div className="frh-step-num">3</div>
            <div className="frh-step-text">
              <strong>Compare</strong> multiple annotations using the Compare button at the bottom right
            </div>
          </div>
        </div>
        {uiMode === 'basic' && (
          <div className="frh-mode-hint">
            You're in <strong>Basic mode</strong> — switch to <strong>Advanced</strong> in the top bar
            to unlock normalization, smoothing, correlates, and mapping tools.
          </div>
        )}
      </div>
    )
  }

// ── Theme Toggle ───────────────────────────────────────────────────────────

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      className="theme-toggle"
      onClick={onToggle}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
          <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
      )}
      <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
    </button>
  )
}

// ── Reset Button ───────────────────────────────────────────────────────────

function ResetBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="refresh-btn"
      onClick={onClick}
      title="Reset all page states"
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" width="15" height="15">
        <path d="M4 4v5h5M16 16v-5h-5" />
        <path d="M4 9a7 7 0 0 1 12.9-2.7M16 11a7 7 0 0 1-12.9 2.7" />
      </svg>
      <span>Reset</span>
    </button>
  )
}

// ── Date Range Picker ──────────────────────────────────────────────────────

function DateRangePicker({
  from, to, onFrom, onTo, onClear, minDate, maxDate,
}: {
  from: string; to: string
  onFrom: (v: string) => void; onTo: (v: string) => void
  onClear: () => void
  minDate?: string; maxDate?: string
}) {
  const active = from || to
  return (
    <div className="date-range">
      <span className="date-range-label">Date range:</span>
      <input
        type="date" className="field date-field" value={from}
        min={minDate} max={maxDate}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onFrom(e.target.value)}
      />
      <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>→</span>
      <input
        type="date" className="field date-field" value={to}
        min={minDate} max={maxDate}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onTo(e.target.value)}
      />
      {active && <button className="btn ghost sm" onClick={onClear}>✕ clear</button>}
    </div>
  )
}

// ── Chart Controls Bar ─────────────────────────────────────────────────────

type NormalizeMode = 'none' | 'l1' | 'zscore'

function ChartControls({
  normalizeMode, onNormalizeMode,
  smoothed, onSmooth,
  smoothBandwidth, onSmoothBandwidth,
}: {
  normalizeMode: NormalizeMode; onNormalizeMode: (v: NormalizeMode) => void
  smoothed: boolean; onSmooth: (v: boolean) => void
  smoothBandwidth: number; onSmoothBandwidth: (v: number) => void
}) {
  // Local slider value updates immediately for responsive feel;
  // the debounced value fires onSmoothBandwidth after 150ms of inactivity
  // to prevent O(n²) LOWESS recompute on every pixel of drag.
  const [sliderVal, setSliderVal] = useState(smoothBandwidth)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync if parent resets bandwidth externally
  useEffect(() => { setSliderVal(smoothBandwidth) }, [smoothBandwidth])

  function handleSliderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = Number(e.target.value)
    setSliderVal(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => onSmoothBandwidth(v), 150)
  }

  return (
    <div className="chart-controls">
      <div className="chart-ctrl-group">
        <label className="ctrl-label">Normalize</label>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className={`toggle-pill ${normalizeMode === 'none' ? 'on' : ''}`}
            onClick={() => onNormalizeMode('none')}
            title="Raw EGC values"
          >
            Off
          </button>
          <button
            className={`toggle-pill ${normalizeMode === 'l1' ? 'on' : ''}`}
            onClick={() => onNormalizeMode('l1')}
            title="L1: use pre-computed norm_egc (egc / total sample sequencing depth) — true depth-normalised abundance, comparable across samples"
          >
            L1
          </button>
          <button
            className={`toggle-pill ${normalizeMode === 'zscore' ? 'on' : ''}`}
            onClick={() => onNormalizeMode('zscore')}
            title="Z-score: subtract mean, divide by std dev — best for comparing trends across different scales"
          >
            Z-score
          </button>
        </div>
        {normalizeMode === 'l1' && <span className="ctrl-hint">Depth-normalised EGC (norm_egc)</span>}
        {normalizeMode === 'zscore' && <span className="ctrl-hint">Std deviations from mean</span>}
      </div>
      <div className="chart-ctrl-group">
        <label className="ctrl-label">Smooth</label>
        <button
          className={`toggle-pill ${smoothed ? 'on' : ''}`}
          onClick={() => onSmooth(!smoothed)}
          title="LOWESS: locally weighted regression."
        >
          {smoothed ? 'On' : 'Off'}
        </button>
        {smoothed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="ctrl-hint">Bandwidth:</span>
            <input
              type="range"
              className="smooth-slider"
              min={0.05} max={0.75} step={0.05}
              value={sliderVal}
              onChange={handleSliderChange}
              title={`LOWESS bandwidth: ${sliderVal.toFixed(2)} — fraction of data used as neighbors. Lower = tighter fit, higher = smoother. Above ~0.75 approaches a global linear regression.`}
            />
            <span className="ctrl-hint">{sliderVal.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── EGC Chart (single annotation) ─────────────────────────────────────────

function EgcChart({
  data, annotationId, annotationName, color = 'var(--chart-1)', source = 'cog',
}: {
  data: AnnotationItem[]; annotationId: string; annotationName: string | null; color?: string; source?: string; uiMode?: UiMode
}) {
  const [dateFrom, setDateFrom]               = useState('')
  const [dateTo, setDateTo]                   = useState('')
  const [normalizeMode, setNormalizeMode]     = useState<NormalizeMode>('none')
  const [smoothed, setSmoothed]               = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.4)
  const [showStats, setShowStats]             = useState(false)
  const [tpPanelOpen, setTpPanelOpen]         = useState(false)
  const [selectedDates, setSelectedDates]     = useState<Set<string> | null>(null) // null = all
  const [brushRange, setBrushRange]           = useState<{ startIndex: number; endIndex: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  // ── Build sorted full point list ────────────────────────────────────────
  const allPoints = useMemo(() => (
    [...data]
      .filter(d => d.timepoint?.datetime)
      .sort((a, b) => parseDateTime(a.timepoint!.datetime) - parseDateTime(b.timepoint!.datetime))
      .map(d => ({
        date:     fmtDate(d.timepoint?.datetime ?? ''),
        iso:      isoDate(d.timepoint?.datetime ?? ''),
        datetime: d.timepoint?.datetime ?? '',
        egc:      extractEgc(d.value),
        norm_egc: extractNormEgc(d.value),
        sample:   d.sample,
      }))
      .filter(d => d.egc !== null)
  ), [data])

  // ── All unique calendar dates for the timepoint selector ────────────────
  const allDates = useMemo(() => {
    const seen = new Set<string>()
    const dates: string[] = []
    for (const pt of allPoints) {
      const day = pt.datetime.split(' ')[0] ?? ''
      if (!seen.has(day)) { seen.add(day); dates.push(day) }
    }
    return dates
  }, [allPoints])

  // Initialise selectedDates to all once we know allDates
  useEffect(() => {
    if (allDates.length > 0 && selectedDates === null) {
      setSelectedDates(new Set(allDates))
    }
  }, [allDates])

  const allSelected = selectedDates === null || selectedDates.size === allDates.length

  // ── Date range + timepoint filter ───────────────────────────────────────
  const filteredPoints = useMemo(() =>
    allPoints.filter(d => {
      if (dateFrom && d.iso < dateFrom) return false
      if (dateTo   && d.iso > dateTo)   return false
      if (!allSelected && selectedDates) {
        const day = d.datetime.split(' ')[0] ?? ''
        if (!selectedDates.has(day)) return false
      }
      return true
    }),
  [allPoints, dateFrom, dateTo, selectedDates, allSelected])

  // ── Normalisation + smoothing ────────────────────────────────────────────
  const processedPoints = useMemo(() => {
    let pts = (normalizeMode === 'l1'
      ? filteredPoints.map(d => ({ ...d, egc: (d as typeof d & { norm_egc: number | null }).norm_egc ?? null }))
      : filteredPoints
    ) as { egc: number | null; datetime: string; date: string; iso: string; sample: string }[]
    if (normalizeMode === 'zscore') pts = applyZScore(pts) as typeof pts
    if (smoothed) pts = applyLowess(pts, smoothBandwidth) as typeof pts
    return pts
  }, [filteredPoints, normalizeMode, smoothed, smoothBandwidth])

  // ── Brush-filtered visible points (for tick formatter) ───────────────────
  const visiblePoints = useMemo(() => {
    if (!brushRange) return processedPoints
    return processedPoints.slice(brushRange.startIndex, brushRange.endIndex + 1)
  }, [processedPoints, brushRange])

  // ── Day shading bands ────────────────────────────────────────────────────
  const dayBands = useMemo(() => computeDayBands(processedPoints), [processedPoints])

  // ── Unique day count for tick formatter ──────────────────────────────────
  const uniqueDayCount = useMemo(() => {
    const days = new Set(visiblePoints.map(p => p.datetime.split(' ')[0]))
    return days.size
  }, [visiblePoints])

  const tickFormatter = useMemo(
    () => makeTickFormatter(processedPoints, uniqueDayCount),
    [processedPoints, uniqueDayCount]
  )

  const egcVals = useMemo(
    () => processedPoints.map(d => d.egc).filter((v): v is number => v !== null),
    [processedPoints]
  )

  const yLabel = normalizeMode === 'l1' ? 'norm_egc (EGC / sample depth)'
    : normalizeMode === 'zscore' ? 'EGC (Z-score, σ from mean)'
    : 'EGC'

  const yFormatter = normalizeMode === 'l1'
    ? (v: number) => (v * 100).toFixed(2) + '%'
    : normalizeMode === 'zscore'
    ? (v: number) => v.toFixed(2) + 'σ'
    : (v: number) => v.toExponential(1)

  const handleExportCsv = () => downloadCsv(
    processedPoints.map(d => ({ annotation_id: annotationId, sample: d.sample, date: d.datetime, egc: d.egc })),
    `${annotationId}_egc_timeseries.csv`
  )
  const handleExportPng = () => downloadChartPng(
    chartRef,
    `${annotationId}_egc_timeseries.png`,
    `${annotationId}${annotationName ? ` — ${annotationName}` : ''}`
  )
  const handleExportSvg = () => downloadChartSvg(
    chartRef,
    `${annotationId}_egc_timeseries.svg`,
    `${annotationId}${annotationName ? ` — ${annotationName}` : ''}`
  )

  if (allPoints.length === 0) {
    return (
      <div className="state-box" style={{ padding: '24px' }}>
        <div className="state-icon">〰</div>
        <span>No EGC values found across samples for this annotation.</span>
      </div>
    )
  }

  const CustomTooltip = ({
    active, payload,
  }: { active?: boolean; payload?: { payload: typeof processedPoints[0] }[] }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    const fmtVal = (v: number | null) => {
      if (v === null) return '--'
      if (normalizeMode === 'l1') return (v * 100).toFixed(4) + '%'
      if (normalizeMode === 'zscore') return v.toFixed(3) + 'σ'
      return v.toExponential(3)
    }
    return (
      <div className="chart-tooltip">
        <div className="tt-date">{d.datetime}</div>
        <div className="tt-row">
          <div className="tt-dot" style={{ background: color }} />
          <span className="tt-label">{yLabel}</span>
          <span className="tt-val">{fmtVal(d.egc)}</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-dim)' }}>{d.sample}</div>
      </div>
    )
  }

  // Timepoint selector badge
  const tpBadge = !allSelected && selectedDates
    ? ` (${selectedDates.size} of ${allDates.length})`
    : ''

  return (
    <div className="chart-card">
      {/* ── Header ── */}
      <div className="chart-card-header">
        <div>
          <div className="chart-card-title">
            {annotationId}{annotationName ? ` — ${annotationName}` : ''}
          </div>
          <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text-dim)', marginTop: 2 }}>
            {yLabel} · {processedPoints.length} of {allPoints.length} samples
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            className={`toggle-pill sm ${tpPanelOpen ? 'on' : ''}`}
            onClick={() => setTpPanelOpen(o => !o)}
            title="Select which timepoints to display"
            style={!allSelected ? { outline: '1.5px solid var(--teal)' } : undefined}
          >
            ⚙ Timepoints{tpBadge}
          </button>
          <button
            className={`toggle-pill sm ${showStats ? 'on' : ''}`}
            onClick={() => setShowStats(s => !s)}
          >
            Σ Stats
          </button>
          <button className="btn sm" onClick={handleExportPng}>↓ PNG</button>
          <button className="btn sm" onClick={handleExportSvg}>↓ SVG</button>
          <button className="btn sm" onClick={handleExportCsv}>↓ CSV</button>
        </div>
      </div>

      {/* ── Stats panel ── */}
      {showStats && <StatsPanel vals={egcVals} yLabel={yLabel} />}

      {/* ── Timepoint selector panel ── */}
      {tpPanelOpen && allDates.length > 0 && (
        <div className="expand-anim" style={{
          padding: '10px 14px 12px',
          background: 'var(--surface2)',
          borderRadius: 6,
          marginBottom: 10,
          border: '1px solid var(--border)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            marginBottom: 8, flexWrap: 'wrap',
          }}>
            <span style={{ font: '600 10px var(--mono)', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.1em' }}>
              Filter by date
            </span>
            <button
              className="btn ghost sm"
              onClick={() => setSelectedDates(new Set(allDates))}
              style={{ fontSize: 10, padding: '1px 7px' }}
            >
              All
            </button>
            <button
              className="btn ghost sm"
              onClick={() => setSelectedDates(new Set())}
              style={{ fontSize: 10, padding: '1px 7px' }}
            >
              None
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {allDates.map(day => {
              const active = selectedDates?.has(day) ?? true
              // Display as MM/DD only
              const parts = day.split('/')
              const label = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : day
              return (
                <button
                  key={day}
                  className={`toggle-pill sm ${active ? 'on' : ''}`}
                  onClick={() => {
                    setSelectedDates(prev => {
                      const next = new Set(prev ?? allDates)
                      if (next.has(day)) next.delete(day)
                      else next.add(day)
                      return next
                    })
                  }}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11 }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Date range picker ── */}
      <div style={{ marginBottom: 10 }}>
        <DateRangePicker
          from={dateFrom} to={dateTo}
          onFrom={setDateFrom} onTo={setDateTo}
          onClear={() => { setDateFrom(''); setDateTo('') }}
        />
      </div>

      {/* ── Chart controls ── */}
      <AdvancedOnly mode={uiMode ?? 'advanced'}>
        <ChartControls
          normalizeMode={normalizeMode} onNormalizeMode={setNormalizeMode}
          smoothed={smoothed} onSmooth={setSmoothed}
          smoothBandwidth={smoothBandwidth} onSmoothBandwidth={setSmoothBandwidth}
        />
      </AdvancedOnly>

      {/* ── Chart ── */}
      {processedPoints.length === 0 ? (
        <div className="state-box" style={{ padding: '20px' }}>
          <span>No data in selected range.</span>
        </div>
      ) : (
        <div ref={chartRef}>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart
              data={processedPoints}
              margin={{ top: 6, right: 16, left: 0, bottom: 8 }}
            >
              {/* Day shading — rendered first so it sits behind grid + line */}
              {dayBands.map((band, i) =>
                band.shade ? (
                  <ReferenceArea
                    key={i}
                    x1={band.x1}
                    x2={band.x2}
                    fill="rgba(0,0,0,0.04)"
                    fillOpacity={1}
                    strokeOpacity={0}
                    ifOverflow="visible"
                  />
                ) : null
              )}

              <CartesianGrid strokeDasharray="" stroke="#d9d9d9" vertical={false} />

              {normalizeMode === 'zscore' && (
                <CartesianGrid
                  horizontal={false} vertical={false}
                  stroke="var(--text-dim)" strokeDasharray="6 3"
                />
              )}

              <XAxis
                dataKey="datetime"
                tick={{ fill: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border)' }}
                angle={-40}
                textAnchor="end"
                height={56}
                tickFormatter={tickFormatter}
                interval={0}
              />
              <YAxis
                tick={{ fill: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border)' }}
                width={72}
                tickFormatter={yFormatter}
                label={{
                  value: yLabel, angle: -90, position: 'insideLeft',
                  fill: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)', dy: 40,
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="egc"
                stroke={color}
                strokeWidth={2}
                dot={{ r: 4, fill: color, strokeWidth: 0 }}
                activeDot={{ r: 6, fill: color, stroke: 'var(--bg)', strokeWidth: 2 }}
                connectNulls={false}
              />
              <Brush
                dataKey="datetime"
                height={24}
                stroke="var(--border)"
                fill="var(--surface2)"
                travellerWidth={6}
                tickFormatter={(value: string) => {
                  const day = value.split(' ')[0] ?? ''
                  const parts = day.split('/')
                  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : day
                }}
                onChange={(range) => {
                  if (
                    range &&
                    typeof range.startIndex === 'number' &&
                    typeof range.endIndex === 'number'
                  ) {
                    setBrushRange({ startIndex: range.startIndex, endIndex: range.endIndex })
                  }
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

// ── Multi-line EGC chart (Compare page) ────────────────────────────────────

function MultiEgcChart({
  series, dateFrom, dateTo,
}: 
{
  series: { annotationId: string; name: string | null; data: AnnotationItem[]; color: string; isGrouped?: boolean }[]
  dateFrom: string; dateTo: string
}) {
  const [normalizeMode, setNormalizeMode] = useState<NormalizeMode>('none')
  const [smoothed, setSmoothed]     = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.4)
  const [showStats, setShowStats]   = useState(false)
  const [brushRange, setBrushRange] = useState<{ startIndex: number; endIndex: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  type ChartRow = { date: string; _dt: string } & Record<string, number | null | string>

  const baseRows = useMemo<ChartRow[]>(() => {
    const dtMap: Record<string, ChartRow> = {}
    for (const s of series) {
      for (const d of s.data) {
        const iso = isoDate(d.timepoint?.datetime ?? '')
        if (dateFrom && iso < dateFrom) continue
        if (dateTo   && iso > dateTo)   continue
        const dt = d.timepoint?.datetime ?? ''
        if (!dtMap[dt]) dtMap[dt] = { date: fmtDate(dt), _dt: dt }
        dtMap[dt][s.annotationId]            = extractEgc(d.value)
        dtMap[dt][s.annotationId + '__norm']  = extractNormEgc(d.value)
      }
    }
    return Object.values(dtMap).sort((a, b) => parseDateTime(a._dt) - parseDateTime(b._dt))
  }, [series, dateFrom, dateTo])

  // timepointTotals removed — L1 mode now uses pre-computed norm_egc from
  // the backend instead of dividing by the arbitrary series total.

  const chartData = useMemo<ChartRow[]>(() => {
    if (normalizeMode === 'none' && !smoothed) return baseRows
    let rows = baseRows
    for (const s of series) {
      // L1 mode: use pre-computed norm_egc directly (already depth-normalised).
      // Z-score / smooth: operate on raw egc as before.
      let processed: { egc: number | null; datetime?: string }[]
      if (normalizeMode === 'l1') {
        processed = rows.map(row => ({
          egc: (row[s.annotationId + '__norm'] as number | null) ?? null,
          datetime: row._dt,
        }))
      } else {
        processed = rows.map(row => ({
          egc: (row[s.annotationId] as number | null) ?? null,
          datetime: row._dt,
        }))
      }
      if (normalizeMode === 'zscore') processed = applyZScore(processed)
      if (smoothed) processed = applyLowess(processed, smoothBandwidth)
      rows = rows.map((row, i) => ({ ...row, [s.annotationId]: processed[i].egc }))
    }
    return rows
  }, [baseRows, normalizeMode, smoothed, smoothBandwidth, series])

  // Day shading bands — derived from full datetime strings in _dt field
  const dayBands = useMemo(
    () => computeDayBands(chartData.map(r => ({ datetime: r._dt as string }))),
    [chartData]
  )

  // Visible points after brush zoom — used to switch tick formatter context
  const visibleRows = useMemo(() => {
    if (!brushRange) return chartData
    return chartData.slice(brushRange.startIndex, brushRange.endIndex + 1)
  }, [chartData, brushRange])

  const uniqueDayCount = useMemo(() => {
    const days = new Set(visibleRows.map(r => (r._dt as string).split(' ')[0]))
    return days.size
  }, [visibleRows])

  const tickFormatter = useMemo(
    () => makeTickFormatter(
      chartData.map(r => ({ datetime: r._dt as string })),
      uniqueDayCount
    ),
    [chartData, uniqueDayCount]
  )

  const seriesTitle = series.map(s => s.annotationId).join(' vs ')
  const handleExportPng = () => downloadChartPng(chartRef, 'compare_egc.png', `Compare: ${seriesTitle}`)
  const handleExportSvg = () => downloadChartSvg(chartRef, 'compare_egc.svg', `Compare: ${seriesTitle}`)
  const handleExportCsv = () => {
    const rows: Record<string, unknown>[] = []
    for (const row of chartData) {
      for (const s of series) {
        const val = row[s.annotationId]
        if (val !== null && val !== undefined) {
          rows.push({
            annotation_id: s.annotationId,
            source:        s.source ?? '',
            date:          row._dt ?? row.date,
            egc_normalized: val,
            normalize_mode: normalizeMode,
          })
        }
      }
    }
    downloadCsv(rows, `compare_egc_${normalizeMode}.csv`)
  }

  // All processed values across all series for stats
  const allVals = useMemo(() => {
    const out: number[] = []
    for (const s of series) {
      for (const row of chartData) {
        const v = row[s.annotationId]
        if (typeof v === 'number') out.push(v)
      }
    }
    return out
  }, [chartData, series])

  // Warn if series have very different scales (EGC mode only)
  const scaleMismatch = useMemo(() => {
    if (normalizeMode !== 'none') return false
    const means = series.map(s => {
      const vals = s.data.map(d => extractEgc(d.value)).filter((v): v is number => v !== null)
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    }).filter(m => m > 0)
    if (means.length < 2) return false
    return Math.max(...means) / Math.min(...means) > 10
  }, [series, normalizeMode])

  if (chartData.length === 0) {
    return (
      <div className="state-box">
        <div className="state-icon">〰</div>
        <span>No EGC data in range.</span>
      </div>
    )
  }

  // const step      = Math.max(1, Math.ceil(chartData.length / 10))
  const yLabel    = normalizeMode === 'l1' ? 'norm_egc (EGC / sample depth)'
    : normalizeMode === 'zscore' ? 'Z-score (σ from mean)'
    : 'EGC'
  const yFormatter = normalizeMode === 'l1'
    ? (v: number) => (v * 100).toFixed(1) + '%'
    : normalizeMode === 'zscore'
    ? (v: number) => v.toFixed(1) + 'σ'
    : (v: number) => v.toExponential(1)

  const CustomTooltip = ({
    active, payload, label,
  }: {
    active?: boolean
    payload?: { color: string; dataKey: string; value: number }[]
    label?: string
  }) => {
    if (!active || !payload?.length) return null
    const fmtVal = (v: number) => {
      if (normalizeMode === 'l1') return (v * 100).toFixed(3) + '%'
      if (normalizeMode === 'zscore') return v.toFixed(3) + 'σ'
      return v.toExponential(3)
    }
    return (
      <div className="chart-tooltip">
        <div className="tt-date">{label}</div>
        {payload.map((p, i) => (
          <div className="tt-row" key={i}>
            <div className="tt-dot" style={{ background: p.color }} />
            <span className="tt-label" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.dataKey}
            </span>
            <span className="tt-val">
              {typeof p.value === 'number' ? fmtVal(p.value) : '--'}
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <div className="chart-card-title">{yLabel} — {series.length} Annotations</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className={`toggle-pill sm ${showStats ? 'on' : ''}`}
            onClick={() => setShowStats(s => !s)}
          >
            Σ Stats
          </button>
          <button className="btn sm" onClick={handleExportPng}>↓ PNG</button>
          <button className="btn sm" onClick={handleExportSvg}>↓ SVG</button>
          <button className="btn sm" onClick={handleExportCsv}>↓ CSV</button>
          <div className="chart-legend">
            {series.map(s => (
              <div className="legend-item" key={s.annotationId}>
                <div className="legend-dot" style={{ background: s.color }} />
                <span title={s.name ?? s.annotationId}>{s.annotationId}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {showStats && <StatsPanel vals={allVals} yLabel={yLabel} />}
      {scaleMismatch && (
        <div style={{
          padding: '6px 12px', marginBottom: 8, borderRadius: 5,
          background: 'rgba(245,188,48,.12)', border: '1px solid rgba(245,188,48,.3)',
          font: '12px var(--mono)', color: 'var(--amber)',
        }}>
          ⚠ Series have very different EGC scales. Use <strong>Z-score</strong> normalize for trend comparison.
        </div>
      )}
      <ChartControls
        normalizeMode={normalizeMode} onNormalizeMode={setNormalizeMode}
        smoothed={smoothed} onSmooth={setSmoothed}
        smoothBandwidth={smoothBandwidth} onSmoothBandwidth={setSmoothBandwidth}
      />
      <div ref={chartRef}>
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={chartData} margin={{ top: 6, right: 16, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="" stroke="#d9d9d9" vertical={false} />
            <XAxis
              dataKey="_dt"
              tick={{ fill: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}
              tickLine={false} axisLine={{ stroke: 'var(--border)' }}
              angle={-40} textAnchor="end" height={56}
              tickFormatter={tickFormatter}
              interval={0}
            />
            <YAxis
              tick={{ fill: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}
              tickLine={false} axisLine={{ stroke: 'var(--border)' }} width={72}
              tickFormatter={yFormatter}
              label={{
                value: yLabel, angle: -90, position: 'insideLeft',
                fill: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)', dy: 40,
              }}
            />
            <Tooltip content={<CustomTooltip />} />
            {(() => {
              // If any series is grouped, apply visual hierarchy:
              //   grouped  → thick (3.5) + full opacity  (stands out)
              //   single   → thin  (1.5) + 45% opacity   (recedes)
              // If no grouped series, all lines render equally at strokeWidth 2.
              const hasGroup = series.some(s => s.isGrouped)
              return series.map(s => {
                const sw      = hasGroup ? (s.isGrouped ? 3.5 : 1.5) : 2
                const opacity = hasGroup ? (s.isGrouped ? 1   : 0.45) : 1
                return (
                  <Line
                    key={s.annotationId} type="monotone" dataKey={s.annotationId}
                    stroke={s.color} strokeWidth={sw} strokeOpacity={opacity}
                    dot={{ r: s.isGrouped ? 4 : 2, fill: s.color, strokeWidth: 0, fillOpacity: opacity }}
                    activeDot={{ r: s.isGrouped ? 6 : 4, fill: s.color }}
                    connectNulls={true}
                  />
                )
              })
            })()}
          <Brush
                dataKey="_dt"
                height={24}
                stroke="var(--border)"
                fill="var(--surface2)"
                travellerWidth={6}
                tickFormatter={(value: string) => {
                  const day = value.split(' ')[0] ?? ''
                  const parts = day.split('/')
                  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : day
                }}
                onChange={(range) => {
                  if (
                    range &&
                    typeof range.startIndex === 'number' &&
                    typeof range.endIndex === 'number'
                  ) {
                    setBrushRange({ startIndex: range.startIndex, endIndex: range.endIndex })
                  }
                }}
              />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ── Mappings Panel ─────────────────────────────────────────────────────────

type MappingSortCol = 'date' | 'time' | 'taxonomy' | 'kegg_id' | 'enzyme' | 'cog_id'
const MAPPINGS_PAGE_SIZE = 100

function MappingsSortTh({
  col, label, sortCol, sortDir, onSort,
}: {
  col: MappingSortCol; label: string
  sortCol: MappingSortCol; sortDir: SortDir
  onSort: (col: MappingSortCol) => void
}) {
  return (
    <th
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}
      <span style={{ marginLeft: 4, opacity: sortCol === col ? 1 : 0.3 }}>
        {sortCol === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  )
}

function MappingsPanel({ annotationId, source }: { annotationId: string; source: string }) {
  const [open, setOpen]               = useState(false)
  const [sampleCount, setSampleCount] = useState(128)
  const [uniqueOnly, setUniqueOnly]   = useState(false)
  const [allRows, setAllRows]         = useState<MappingSearchRow[]>([])
  const [status, setStatus]           = useState<ApiStatus>('idle')
  const [sortCol, setSortCol]         = useState<MappingSortCol>('date')
  const [sortDir, setSortDir]         = useState<SortDir>('asc')
  const [page, setPage]               = useState(1)

  async function loadMappings(count = sampleCount, unique = uniqueOnly) {
    setStatus('loading'); setPage(1)
    try {
      const r = await apiFetch<{ data: MappingSearchRow[]; total: number }>(
        `/api/mappings/search?annotation_id=${encodeURIComponent(annotationId)}&source=${source}&sample_count=${count}&unique_pairs=${unique}`
      )
      setAllRows(r.data ?? [])
      setStatus('ok')
    } catch { setStatus('error') }
  }

  function toggleSort(col: MappingSortCol) {
    if (sortCol === col) setSortDir((d: SortDir) => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
    setPage(1)
  }

  const sortedRows = useMemo(() => (
    [...allRows].sort((a, b) => {
      // Both 'date' and 'time' sort by full datetime (ISO string sorts correctly for both)
      const av = (sortCol === 'date' || sortCol === 'time')
        ? (a.timepoint?.datetime ?? '')
        : ((a[sortCol as keyof MappingRow] ?? '') as string)
      const bv = (sortCol === 'date' || sortCol === 'time')
        ? (b.timepoint?.datetime ?? '')
        : ((b[sortCol as keyof MappingRow] ?? '') as string)
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    })
  ), [allRows, sortCol, sortDir])

  const totalPages = Math.ceil(sortedRows.length / MAPPINGS_PAGE_SIZE)
  const pageRows   = sortedRows.slice((page - 1) * MAPPINGS_PAGE_SIZE, page * MAPPINGS_PAGE_SIZE)

  const SortTh = ({ col, label }: { col: MappingSortCol; label: string }) => (
    <MappingsSortTh col={col} label={label} sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
  )

  return (
    <div style={{ marginTop: 16 }}>
      <hr className="divider" />
      <button
        className={`mappings-toggle ${open ? 'open' : ''}`}
        onClick={() => { setOpen(o => !o); if (!open && status === 'idle') loadMappings() }}
      >
        <span className="toggle-icon">▶</span>
        <span className="toggle-label">View Annotation Mappings</span>
        {status === 'ok' && <span className="toggle-count">{allRows.length} rows</span>}
      </button>

      {open && (
        <div className="expand-anim">
          <div className="mappings-controls">
            <label>Samples:</label>
            <input
              className="field" type="number" min={1} max={128} value={sampleCount}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setSampleCount(Math.max(1, Math.min(128, Number(e.target.value))))}
              style={{ width: 80 }}
            />
            <label style={{ marginLeft: 8 }}>
              <input
                type="checkbox" checked={uniqueOnly}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setUniqueOnly(e.target.checked)
                  loadMappings(sampleCount, e.target.checked)
                }}
                style={{ marginRight: 6 }}
              />
              Unique pairs only
            </label>
            <button
              className="btn sm primary" onClick={() => loadMappings()}
              style={{ marginLeft: 'auto' }}
            >
              Load
            </button>
            {status === 'ok' && allRows.length > 0 && (
              <button
                className="btn sm"
                onClick={() => downloadCsv(
                  sortedRows.map((r: MappingSearchRow) => ({
                    annotation_id: annotationId, source,
                    date: fmtDate(r.timepoint?.datetime ?? ''),
                    time: fmtTime(r.timepoint?.datetime ?? ''),
                    taxonomy: r.taxonomy ?? '', kegg_id: r.kegg_id ?? '',
                    enzyme: r.enzyme ?? '', cog_id: r.cog_id ?? '',
                  })),
                  `${annotationId}_mappings.csv`
                )}
              >
                ↓ CSV
              </button>
            )}
          </div>
          {status === 'loading' && (
            <div className="state-box" style={{ padding: '20px' }}>
              <span>Searching mappings across {sampleCount} samples…</span>
            </div>
          )}
          {status === 'error' && (
            <div className="state-box error" style={{ padding: '20px' }}>
              <span>Failed to load mappings.</span>
            </div>
          )}
          {status === 'ok' && allRows.length === 0 && (
            <div className="state-box" style={{ padding: '20px' }}>
              <span>No mappings found for <strong>{annotationId}</strong>.</span>
            </div>
          )}
          {status === 'ok' && allRows.length > 0 && (
            <>
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table className="mappings-table">
                  <thead>
                    <tr>
                      <SortTh col="date" label="Date" />
                      <SortTh col="time" label="Time (24h)" />
                      <SortTh col="taxonomy" label="Taxonomy" />
                      <SortTh col="kegg_id" label="KEGG" />
                      <SortTh col="enzyme" label="Enzyme" />
                      <SortTh col="cog_id" label="COG" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row: MappingSearchRow, i: number) => (
                      <tr key={i}>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                          {fmtDate(row.timepoint?.datetime ?? '') || '—'}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                          {fmtTime(row.timepoint?.datetime ?? '') || '—'}
                        </td>
                        <td>{row.taxonomy ?? '—'}</td>
                        <td>{row.kegg_id ?? '—'}</td>
                        <td>{row.enzyme ?? '—'}</td>
                        <td>{row.cog_id ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="pagination">
                  <button
                    className="btn sm ghost"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    ‹ Prev
                  </button>
                  <span className="pagination-info">
                    Page {page} of {totalPages} · {allRows.length} rows
                  </span>
                  <button
                    className="btn sm ghost"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                  >
                    Next ›
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Grouped / Summed EGC Chart ─────────────────────────────────────────────

function GroupedEgcChart({
  allSeries, groupLabel,
}: {
  allSeries: { annotationId: string; name: string | null; data: AnnotationItem[]; color: string }[]
  groupLabel: string
}) {
  const [normalizeMode, setNormalizeMode] = useState<NormalizeMode>('none')
  const [smoothed, setSmoothed]         = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.4)
  const [dateFrom, setDateFrom]         = useState('')
  const [dateTo,   setDateTo]           = useState('')
  const [brushRange, setBrushRange] = useState<{ startIndex: number; endIndex: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  const summedPoints = useMemo(() => {
    const dtMap: Record<string, { egc: number; datetime: string; iso: string }> = {}
    for (const s of allSeries) {
      for (const d of s.data) {
        if (!d.timepoint?.datetime) continue
        const iso = isoDate(d.timepoint.datetime)
        if (dateFrom && iso < dateFrom) continue
        if (dateTo   && iso > dateTo)   continue
        const egc = extractEgc(d.value)
        if (egc === null) continue
        const dt = d.timepoint.datetime
        if (!dtMap[dt]) dtMap[dt] = { egc: 0, datetime: dt, iso }
        dtMap[dt].egc += egc
      }
    }
    return Object.values(dtMap)
      .sort((a, b) => parseDateTime(a.datetime) - parseDateTime(b.datetime))
      .map(({ egc, datetime }) => ({ date: fmtDate(datetime), egc, datetime }))
  }, [allSeries, dateFrom, dateTo])

  const processedPoints = useMemo(() => {
    let pts = summedPoints as { egc: number | null; datetime?: string; date: string }[]
    if (normalizeMode === 'l1')     pts = applyL1Normalize(pts) as typeof pts
    if (normalizeMode === 'zscore') pts = applyZScore(pts) as typeof pts
    if (smoothed) pts = applyLowess(pts, smoothBandwidth) as typeof pts
    return pts
  }, [summedPoints, normalizeMode, smoothed, smoothBandwidth])

  const egcVals = useMemo(
    () => processedPoints.map(d => d.egc).filter((v): v is number => v !== null),
    [processedPoints]
  )

  // Day shading + context-aware tick formatter
  const dayBands = useMemo(
    () => computeDayBands(processedPoints.map(p => ({ datetime: (p as typeof p & { datetime: string }).datetime }))),
    [processedPoints]
  )

  const visiblePoints = useMemo(() => {
    if (!brushRange) return processedPoints
    return processedPoints.slice(brushRange.startIndex, brushRange.endIndex + 1)
  }, [processedPoints, brushRange])

  const uniqueDayCount = useMemo(() => {
    const days = new Set(
      visiblePoints.map(p => ((p as typeof p & { datetime: string }).datetime ?? '').split(' ')[0])
    )
    return days.size
  }, [visiblePoints])

  const tickFormatter = useMemo(
    () => makeTickFormatter(
      processedPoints.map(p => ({ datetime: (p as typeof p & { datetime: string }).datetime })),
      uniqueDayCount
    ),
    [processedPoints, uniqueDayCount]
  )
  const yLabel    = normalizeMode === 'l1' ? 'Summed EGC (proportion of group total)'
    : normalizeMode === 'zscore' ? 'Summed EGC (Z-score)'
    : 'Summed EGC'
  const yFormatter = normalizeMode === 'l1'
    ? (v: number) => (v * 100).toFixed(1) + '%'
    : normalizeMode === 'zscore'
    ? (v: number) => v.toFixed(1) + 'σ'
    : (v: number) => v.toExponential(1)

  const handleExportCsv = () => downloadCsv(
    processedPoints.map(d => ({ group: groupLabel, date: d.datetime, egc: d.egc })),
    `${groupLabel}_grouped_egc.csv`
  )
  const handleExportPng = () => downloadChartPng(
    chartRef,
    `${groupLabel}_grouped_egc.png`,
    `Grouped: "${groupLabel}" — ${allSeries.length} annotations summed`
  )
  const handleExportSvg = () => downloadChartSvg(
    chartRef,
    `${groupLabel}_grouped_egc.svg`,
    `Grouped: "${groupLabel}" — ${allSeries.length} annotations summed`
  )

  const CustomTooltip = ({
    active, payload,
  }: { active?: boolean; payload?: { payload: typeof processedPoints[0] }[] }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    const fmtVal = (v: number | null) => {
      if (v === null) return '--'
      if (normalizeMode === 'l1') return (v * 100).toFixed(3) + '%'
      if (normalizeMode === 'zscore') return v.toFixed(3) + 'σ'
      return v.toExponential(3)
    }
    return (
      <div className="chart-tooltip">
        <div className="tt-date">{d.datetime}</div>
        <div className="tt-row">
          <div className="tt-dot" style={{ background: 'var(--chart-1)' }} />
          <span className="tt-label">{yLabel}</span>
          <span className="tt-val">{fmtVal(d.egc)}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <div className="chart-card-header">
        <div>
          <div className="chart-card-title">
            Grouped: &quot;{groupLabel}&quot; — {allSeries.length} annotations summed
          </div>
          <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text-dim)', marginTop: 2 }}>
            {yLabel} · {processedPoints.length} timepoints
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn sm" onClick={handleExportPng}>↓ PNG</button>
          <button className="btn sm" onClick={handleExportSvg}>↓ SVG</button>
          <button className="btn sm" onClick={handleExportCsv}>↓ CSV</button>
        </div>
      </div>
      <StatsPanel vals={egcVals} yLabel={yLabel} />
      <div style={{ marginBottom: 10 }}>
        <DateRangePicker
          from={dateFrom} to={dateTo}
          onFrom={setDateFrom} onTo={setDateTo}
          onClear={() => { setDateFrom(''); setDateTo('') }}
        />
      </div>
      <ChartControls
        normalizeMode={normalizeMode} onNormalizeMode={setNormalizeMode}
        smoothed={smoothed} onSmooth={setSmoothed}
        smoothBandwidth={smoothBandwidth} onSmoothBandwidth={setSmoothBandwidth}
      />
      {processedPoints.length === 0 ? (
        <div className="state-box"><span>No data available.</span></div>
      ) : (
        <div ref={chartRef}>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={processedPoints} margin={{ top: 6, right: 16, left: 0, bottom: 52 }}>
              {dayBands.map((band, i) =>
              band.shade ? (
                <ReferenceArea
                  key={i}
                  x1={band.x1}
                  x2={band.x2}
                  fill="rgba(0,0,0,0.04)"
                  fillOpacity={1}
                  strokeOpacity={0}
                  ifOverflow="visible"
                />
              ) : null
            )}
            <CartesianGrid strokeDasharray="" stroke="#d9d9d9" vertical={false} />
              <XAxis
                dataKey="datetime"
                tick={{ fill: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}
                tickLine={false} axisLine={{ stroke: 'var(--border)' }}
                angle={-40} textAnchor="end" height={56}
                tickFormatter={tickFormatter}
                interval={0}
              />
              <YAxis
                tick={{ fill: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}
                tickLine={false} axisLine={{ stroke: 'var(--border)' }} width={72}
                tickFormatter={yFormatter}
                label={{
                  value: yLabel, angle: -90, position: 'insideLeft',
                  fill: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)', dy: 50,
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone" dataKey="egc"
                stroke="var(--chart-1)" strokeWidth={3.7}
                dot={{ r: 4, fill: 'var(--chart-1)', strokeWidth: 0 }}
                activeDot={{ r: 6 }}
                connectNulls={false}
              />
              <Brush
                dataKey="datetime"
                height={24}
                stroke="var(--border)"
                fill="var(--surface2)"
                travellerWidth={6}
                tickFormatter={(value: string) => {
                  const day = value.split(' ')[0] ?? ''
                  const parts = day.split('/')
                  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : day
                }}
                onChange={(range) => {
                  if (
                    range &&
                    typeof range.startIndex === 'number' &&
                    typeof range.endIndex === 'number'
                  ) {
                    setBrushRange({ startIndex: range.startIndex, endIndex: range.endIndex })
                  }
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

// ── Shared annotation type ─────────────────────────────────────────────────

type SharedAnnotation = { annotationId: string; source: string; name: string | null }
type SeriesCache = Record<string, { data: AnnotationItem[]; status: ApiStatus }>

// ── Right-column card type ─────────────────────────────────────────────────
// Each card is either a single annotation chart or a grouped/summed chart.

type RightCard =
  | { kind: 'single'; key: string; annotationId: string; source: string; name: string | null; color: string; parent: string | null }
  | { kind: 'group';  key: string; label: string; annotationIds: string[]; sources: string[] }

// ── Analyze Page state (lifted to App for persistence) ────────────────────

type AnalyzeState = {
  // Search bar
  queryFields:   string[]
  sources:       string[]
  // Results
  resultsByTerm: AnnotationItem[][]
  totalsByTerm:  number[]           // full match count from backend (before page slice)
  searchStatus:  ApiStatus
  // Left column — active term tab index
  activeTermIdx: number
  // Left column — checked rows per term (key = term string → set of annotation_id::source)
  checkedByTerm: Record<string, Set<string>>
  // Right column — ordered list of open cards
  rightCards:    RightCard[]
  // Series data cache (shared between left and right)
  seriesCache:   SeriesCache
  // Compare drawer
  drawerOpen:    boolean
  drawerChecked: Set<string>  // keys of rightCards included in compare
}

function makeDefaultAnalyzeState(): AnalyzeState {
  return {
    queryFields: [''], sources: ['kegg', 'cog', 'enzyme', 'taxonomy'],
    resultsByTerm: [], totalsByTerm: [], searchStatus: 'idle',
    activeTermIdx: 0,
    checkedByTerm: {},
    rightCards: [],
    seriesCache: {},
    drawerOpen: false,
    drawerChecked: new Set(),
  }
}

// ── Left column result list ────────────────────────────────────────────────

function LeftResultList({
  rows, termLabel, checkedKeys, seriesCache,
  rightCardKeys, copiedId, onCopy,
  onToggleCheck, onAddSingle, onAddSelected, onGroupSelected,
  total,
}: {
  rows:          AnnotationItem[]
  termLabel:     string
  checkedKeys:   Set<string>
  seriesCache:   SeriesCache
  rightCardKeys: Set<string>
  copiedId:      string | null
  onCopy:        (id: string) => void
  onToggleCheck: (key: string) => void
  onAddSingle:   (ann: AnnotationItem) => void
  onAddSelected: () => void
  onGroupSelected: () => void
  total:         number   // full match count from backend
}) {
  const maxEgc = useMemo(
    () => Math.max(...rows.map(r => r.mean_egc ?? 0), 1),
    [rows]
  )

  const allKeys       = rows.map(r => `${r.annotation_id}::${r.source}`)
  const allChecked    = allKeys.length > 0 && allKeys.every(k => checkedKeys.has(k))
  const someChecked   = checkedKeys.size > 0
  const checkedCount  = checkedKeys.size

  return (
    <div className="al-left-list">
      {/* ── Bulk action bar — always visible ── */}
      <div className="al-bulk-bar">
        <label className="al-select-all" title="Select or deselect all visible rows">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={() => {
              if (allChecked) allKeys.forEach(k => onToggleCheck(k))
              else allKeys.filter(k => !checkedKeys.has(k)).forEach(k => onToggleCheck(k))
            }}
          />
          <span style={{ color: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}>
            {someChecked ? `${checkedCount} selected` : 'Select all'}
          </span>
        </label>

        {/* Hint when nothing is checked */}
        {!someChecked && rows.length > 0 && (
          <span style={{ font: '10px var(--sans)', color: 'var(--text-dim)', fontStyle: 'italic', marginLeft: 4 }}>
            ← check rows to group or bulk-add
          </span>
        )}

        {/* Action buttons — always rendered, disabled when nothing checked */}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button
            className="btn sm ghost"
            onClick={onGroupSelected}
            disabled={checkedCount < 2}
            title={
              checkedCount === 0 ? 'Check at least 2 rows to create a summed group chart' :
              checkedCount === 1 ? 'Check at least 2 rows to group (currently 1 selected)' :
              `Sum EGC across ${checkedCount} selected annotations into one chart`
            }
          >
            ∑ Group
          </button>
          <button
            className="btn sm primary"
            onClick={onAddSelected}
            disabled={checkedCount === 0}
            title={
              checkedCount === 0 ? 'Check rows to add as individual charts' :
              `Add ${checkedCount} annotation${checkedCount !== 1 ? 's' : ''} as individual charts`
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
              <span className="al-result-showing"> · showing top {rows.length}</span>
            )}
          </span>
          <span className="al-result-hint">
            sorted by relevance · then EGC
            {total > rows.length && ' · refine to narrow'}
          </span>
        </div>
      )}
      {/* ── Rows ── */}
      <div className="al-rows">
        {rows.map(ann => {
          const key      = `${ann.annotation_id}::${ann.source}`
          const inRight  = rightCardKeys.has(key)
          const isChecked = checkedKeys.has(key)
          const hasMeta  = ann.mean_egc != null
          const loading  = seriesCache[key]?.status === 'loading'

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
                {isChecked && <span className="al-row-checkbox-tick">✓</span>}
              </button>
              <div className="al-row-body" onClick={() => !inRight && onAddSingle(ann)}>
                <div className="al-row-top">
                  <CopyBtn id={ann.annotation_id} copiedId={copiedId} onCopy={onCopy} />
                  <span className="al-row-id">{ann.annotation_id}</span>
                  <span className={`tag ${SOURCE_TAG_CLS[ann.source] ?? ''}`}>{ann.source}</span>
                </div>
                <div className="al-row-name">{ann.name ?? '—'}</div>
                {hasMeta && (
                  <div className="al-row-meta">
                    <span>{(ann.mean_egc as number).toExponential(2)}</span>
                    <div className="al-row-bar">
                      <div style={{
                        height: '100%', borderRadius: 2,
                        width: `${((ann.mean_egc as number) / maxEgc) * 100}%`,
                        background: SOURCE_COLORS[ann.source] ?? 'var(--chart-1)',
                      }} />
                    </div>
                  </div>
                )}
              </div>
              <button
                className={`al-add-btn ${inRight ? 'al-add-btn-added' : ''}`}
                title={inRight ? 'Already in view — click chart × to remove' : 'Add chart to right panel'}
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

// ── Correlates Panel ───────────────────────────────────────────────────────
// "Find Correlates" — opens inline below the chart card header.
// Two tabs: cross-source (KEGG vs Taxonomy) and within-source (parent-filtered).
// Each result row shows r, lag in hours, p-value, and a + button to add as chart.

type CorrTab = 'cross' | 'within'

function CorrelatesPanel({
  annotationId, source, onAddAnnotation,
}: {
  annotationId: string
  source:       string
  onAddAnnotation: (annotationId: string, source: string, name: string | null) => void
}) {
  const [open,      setOpen]      = useState(false)
  const [tab,       setTab]       = useState<CorrTab>('cross')
  const [crossData, setCrossData] = useState<CorrelateResult[]>([])
  const [withinData,setWithinData]= useState<CorrelateResult[]>([])
  const [crossStatus, setCrossStatus]   = useState<ApiStatus>('idle')
  const [withinStatus,setWithinStatus]  = useState<ApiStatus>('idle')

  // Target source — user-selectable, defaults to taxonomy (or kegg if source is taxonomy)
  const defaultTarget = source === 'taxonomy' ? 'kegg' : 'taxonomy'
  const [targetSource, setTargetSource] = useState<string>(defaultTarget)
  const allSources = ['kegg', 'cog', 'enzyme', 'taxonomy'] as const
  // When user picks a new cross-source target, clear stale cross results and re-fetch
  useEffect(() => {
    if (open && tab === 'cross') {
      setCrossData([])
      setCrossStatus('idle')
      fetchCorr('cross')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSource])
  async function fetchCorr(mode: CorrTab) {
    const setStatus = mode === 'cross' ? setCrossStatus : setWithinStatus
    const setData   = mode === 'cross' ? setCrossData   : setWithinData
    if ((mode === 'cross' ? crossStatus : withinStatus) === 'loading') return
    setStatus('loading')
    try {
      const base = `/api/annotations/correlate?source=${source}&annotation_id=${encodeURIComponent(annotationId)}&mode=${mode}`
      // Include target_source explicitly for cross — avoids backend ambiguity
      const modeParam = mode === 'cross' ? `&target_source=${targetSource}` : ''
      const fastUrl = `${base}${modeParam}&skip_pvalue=true&limit=15`
      const fast = await apiFetch<{ data: CorrelateResult[] }>(fastUrl)
      setData(fast.data ?? [])
      setStatus('ok')
      // Fetch full p-values in background, silently update when ready
      const fullUrl = `${base}${modeParam}&skip_pvalue=false&limit=15`
      apiFetch<{ data: CorrelateResult[] }>(fullUrl)
        .then(full => setData(full.data ?? []))
        .catch(() => {})
    } catch {
      setStatus('error')
    }
  }

  function handleOpen() {
    setOpen(o => {
      if (!o) {
        // Pre-fetch cross on first open
        if (crossStatus === 'idle') fetchCorr('cross')
      }
      return !o
    })
  }

  function handleTabChange(t: CorrTab) {
    setTab(t)
    if (t === 'within' && withinStatus === 'idle') fetchCorr('within')
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
          {/* Pill tab bar */}
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
          </div>
          {/* Cross-source target selector — only shown on cross tab */}
          {tab === 'cross' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 10px', borderBottom: '1px solid var(--border)',
              background: 'var(--surface2)',
            }}>
              <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                Compare against:
              </span>
              {allSources.filter(s => s !== source).map(s => (
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
          <div className="corr-results">
            {status === 'loading' && (
              <div className="corr-empty">
                <span className="corr-empty-icon">⟳</span>
                Computing correlations…
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
                No correlates above threshold (|r| &gt; {tab === 'cross' ? '0.2' : '0.3'}).
              </div>
            )}
            {status === 'ok' && data.length > 0 && (
              <>
                <div className="corr-legend">
                  Spearman r · CLR EGC · circular-shift permutation
                  {data.some(d => d.p_value === null) &&
                    <span className="corr-legend-loading"> · p loading…</span>}
                  {data.some(d => d.n_pairs < 30) &&
                    <span className="corr-legend-warn"> · ⚠ some n&lt;30</span>}
                </div>
                {data.map(row => {
                  const lowN = row.n_pairs < 30
                  const posR = row.spearman_r >= 0
                  return (
                    <div
                      key={`${row.annotation_id}::${row.source}`}
                      className={`corr-row ${lowN ? 'corr-row-dim' : ''}`}
                    >
                      {/* Strength bar — visual anchor */}
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
                            {externalLink(row.annotation_id, row.source)}
                          </span>
                          {row.name && (
                            <span className="corr-row-name" title={row.name}>{row.name}</span>
                          )}
                        </div>
                        <div className="corr-row-stats">
                          <span
                            className={`corr-stat-r ${posR ? 'corr-stat-pos' : 'corr-stat-neg'}`}
                            title="Spearman r on CLR-transformed EGC"
                          >
                            {posR ? '+' : ''}{row.spearman_r.toFixed(3)}
                          </span>
                          <span className="corr-stat-meta"
                            title="Time offset. Positive = candidate peaks earlier."
                          >
                            {fmtLag(row.lag_hours)}
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
                            title={lowN
                              ? `Only ${row.n_pairs} co-occurring timepoints — treat as exploratory`
                              : `${row.n_pairs} co-occurring timepoints`}
                          >
                            {lowN ? '⚠ ' : ''}n={row.n_pairs}
                          </span>
                          <button
                            className="corr-add-btn"
                            title={`Add ${row.annotation_id} as a new chart`}
                            onClick={() => onAddAnnotation(row.annotation_id, row.source, row.name)}
                          >+</button>
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

// ── Annotation Info Drawer (Option 1) ─────────────────────────────────────
// Toggled by an ℹ button in the chart card header.
// Shows full metadata + all external database links in a clean collapsible panel.

function AnnotationInfoDrawer({
  annotationId, source, name, parent,
}: {
  annotationId: string
  source:       string
  name:         string | null
  parent:       string | null
}) {
  const [open, setOpen] = useState(false)
  const links = externalLinks(annotationId, source)

  return (
    <>
      <button
        className={`card-info-btn ${open ? 'card-info-btn-active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Show annotation details and database links"
      >
        ℹ
      </button>

      {open && (
        <div className="card-info-drawer expand-anim">
          <div className="card-info-row">
            <span className="card-info-label">ID</span>
            <span className="card-info-value mono">{annotationId}</span>
          </div>
          {name && (
            <div className="card-info-row">
              <span className="card-info-label">Name</span>
              <span className="card-info-value">{name}</span>
            </div>
          )}
          {parent && (
            <div className="card-info-row">
              <span className="card-info-label">Parent</span>
              <span className="card-info-value">{expandParentLabel(parent, source)}</span>
            </div>
          )}
          <div className="card-info-row">
            <span className="card-info-label">Source</span>
            <span className={`tag ${SOURCE_TAG_CLS[source] ?? ''}`}>{source}</span>
          </div>
          {links && (
            <div className="card-info-row card-info-links-row">
              <span className="card-info-label">Links</span>
              <div className="card-info-links">{links}</div>
            </div>
          )}
        </div>
      )}
    </>
  )
}

// ── Scaffold List Modal ────────────────────────────────────────────────────

type ScaffoldSortCol = 'date' | 'scaffold_count' | 'gene_count'
 
function ScaffoldModal({
  annotationId, source, onClose, onGoExplore,
}: {
  annotationId: string
  source:       string
  onClose:      () => void
  onGoExplore?: (annotationId: string, source: string) => void
}) {
  const [summary, setSummary]             = useState<ScaffoldSummaryRow[]>([])
  const [status, setStatus]               = useState<ApiStatus>('loading')
  const [sortCol, setSortCol]             = useState<ScaffoldSortCol>('date')
  const [sortDir, setSortDir]             = useState<SortDir>('asc')
  const [expandedSample, setExpanded]     = useState<string | null>(null)
  const [detailRows, setDetailRows]       = useState<ScaffoldDetailRow[]>([])
  const [detailStatus, setDetailStatus]   = useState<ApiStatus>('idle')
  const [detailShowAll, setDetailShowAll] = useState(false)
  const [showChart, setShowChart]         = useState(true)
  const [chartMetric, setChartMetric]     = useState<'scaffold_count' | 'gene_count'>('scaffold_count')
 
  useEffect(() => {
    if (source === 'kegg') { setStatus('error'); return }
    apiFetch<{ data: ScaffoldSummaryRow[]; total: number }>(
      `/api/annotations/scaffolds/summary?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`
    )
      .then(r => { setSummary(r.data ?? []); setStatus('ok') })
      .catch(() => setStatus('error'))
  }, [annotationId, source])
 
  async function loadDetail(sample: string) {
    if (expandedSample === sample) { setExpanded(null); return }
    setExpanded(sample)
    setDetailRows([])
    setDetailShowAll(false)
    setDetailStatus('loading')
    try {
      const r = await apiFetch<{ data: ScaffoldDetailRow[] }>(
        `/api/annotations/scaffolds?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`
      )
      setDetailRows((r.data ?? []).filter(d => d.sample === sample))
      setDetailStatus('ok')
    } catch { setDetailStatus('error') }
  }
 
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
 
  function toggleSort(col: ScaffoldSortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
 
  const sorted = useMemo(() => [...summary].sort((a, b) => {
    const av = sortCol === 'date' ? a.date : a[sortCol]
    const bv = sortCol === 'date' ? b.date : b[sortCol]
    if (typeof av === 'number' && typeof bv === 'number')
      return sortDir === 'asc' ? av - bv : bv - av
    return sortDir === 'asc'
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av))
  }), [summary, sortCol, sortDir])
 
  const chartData = useMemo(() =>
    [...summary].sort((a, b) => a.date.localeCompare(b.date)),
  [summary])
 
  const handleExportCsv = () => downloadCsv(
    sorted.map(r => ({
      annotation_id: annotationId,
      source,
      sample:         r.sample,
      date:           fmtDate(r.date),
      time:           fmtTime(r.date),
      scaffold_count: r.scaffold_count,
      gene_count:     r.gene_count,
    })),
    `${annotationId}_scaffolds_summary.csv`
  )
 
  const SortTh = ({ col, label }: { col: ScaffoldSortCol; label: string }) => (
    <th
      onClick={() => toggleSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}
      <span style={{ marginLeft: 4, opacity: sortCol === col ? 1 : 0.3 }}>
        {sortCol === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  )
 
  const DETAIL_PAGE = 10
 
  return (
    <div
      className="scaffold-modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="scaffold-modal">
 
        <div className="scaffold-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
            <span style={{ font: '600 14px var(--mono)', color: 'var(--teal)' }}>{annotationId}</span>
            <span className={`tag ${SOURCE_TAG_CLS[source] ?? ''}`}>{source}</span>
            <span style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>· Scaffold Summary</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
            {status === 'ok' && summary.length > 0 && (
              <button className="btn sm" onClick={handleExportCsv}>↓ CSV</button>
            )}
            {onGoExplore && status === 'ok' && summary.length > 0 && (
              <button
                className="btn sm primary"
                onClick={() => { onGoExplore(annotationId, source); onClose() }}
                title="Open Scaffold Information tab in Explore with this term pre-loaded"
              >
                → Explore
              </button>
            )}
            <button className="btn sm ghost" onClick={onClose}>✕ Close</button>
          </div>
        </div>
 
        <div className="scaffold-modal-body">
          {status === 'loading' && (
            <div className="state-box" style={{ padding: 32 }}>
              <span>Loading scaffold summary…</span>
            </div>
          )}
          {status === 'error' && (
            <div className="state-box" style={{ padding: 32 }}>
              <div className="state-icon">∅</div>
              <span>
                {source === 'kegg'
                  ? 'Scaffold data is not available for KEGG annotations.'
                  : `No scaffolds found for ${annotationId}.`}
              </span>
            </div>
          )}
          {status === 'ok' && summary.length === 0 && (
            <div className="state-box" style={{ padding: 32 }}>
              <div className="state-icon">∅</div>
              <span>No scaffolds found for {annotationId}.</span>
            </div>
          )}
 
          {status === 'ok' && summary.length > 0 && (<>
 
            <div className="scaffold-stat-strip">
              <div className="scaffold-stat">
                <span className="scaffold-stat-val">{summary.length}</span>
                <span className="scaffold-stat-label">samples</span>
              </div>
              <div className="scaffold-stat">
                <span className="scaffold-stat-val">{Math.max(...summary.map(r => r.scaffold_count))}</span>
                <span className="scaffold-stat-label">peak scaffolds</span>
              </div>
              <div className="scaffold-stat">
                <span className="scaffold-stat-val">{Math.max(...summary.map(r => r.gene_count))}</span>
                <span className="scaffold-stat-label">peak genes</span>
              </div>
              <div className="scaffold-stat">
                <span className="scaffold-stat-val">
                  {Math.round(summary.reduce((s, r) => s + r.gene_count, 0) / summary.length)}
                </span>
                <span className="scaffold-stat-label">avg genes/sample</span>
              </div>
            </div>
 
            <div className="scaffold-chart-zone">
              <div className="scaffold-chart-header">
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    className={`toggle-pill sm ${showChart ? 'on' : ''}`}
                    onClick={() => setShowChart(s => !s)}
                  >
                    {showChart ? '▲ Hide chart' : '▼ Show chart'}
                  </button>
                  {showChart && (<>
                    <button
                      className={`toggle-pill sm ${chartMetric === 'scaffold_count' ? 'on' : ''}`}
                      onClick={() => setChartMetric('scaffold_count')}
                    >Scaffolds</button>
                    <button
                      className={`toggle-pill sm ${chartMetric === 'gene_count' ? 'on' : ''}`}
                      onClick={() => setChartMetric('gene_count')}
                    >Genes</button>
                  </>)}
                </div>
              </div>
              {showChart && (
                <ResponsiveContainer width="100%" height={180}>
                  <ComposedChart data={chartData} margin={{ top: 6, right: 16, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="" stroke="#d9d9d9" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)' }}
                      tickLine={false}
                      axisLine={{ stroke: 'var(--border)' }}
                      angle={-35}
                      textAnchor="end"
                      height={44}
                      tickFormatter={(v: string) => fmtDate(v)}
                      interval={Math.max(1, Math.floor(chartData.length / 8))}
                    />
                    <YAxis
                      tick={{ fill: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)' }}
                      tickLine={false}
                      axisLine={{ stroke: 'var(--border)' }}
                      width={48}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        const d = payload[0].payload as ScaffoldSummaryRow
                        return (
                          <div className="chart-tooltip">
                            <div className="tt-date">{fmtDate(d.date)} {fmtTime(d.date)}</div>
                            <div className="tt-row">
                              <div className="tt-dot" style={{ background: 'var(--chart-1)' }} />
                              <span className="tt-label">{chartMetric === 'scaffold_count' ? 'Scaffolds' : 'Genes'}</span>
                              <span className="tt-val">{chartMetric === 'scaffold_count' ? d.scaffold_count : d.gene_count}</span>
                            </div>
                          </div>
                        )
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey={chartMetric}
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      dot={{ r: 3, fill: 'var(--chart-1)', strokeWidth: 0 }}
                      activeDot={{ r: 5 }}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
 
            <div style={{ overflowX: 'auto' }}>
              <table className="mappings-table scaffold-summary-table">
                <thead>
                  <tr>
                    <SortTh col="date"           label="Date" />
                    <th>Time</th>
                    <SortTh col="scaffold_count" label="Scaffolds" />
                    <SortTh col="gene_count"     label="Genes" />
                    <th style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(row => {
                    const isExpanded    = expandedSample === row.sample
                    const visibleDetail = detailShowAll
                      ? detailRows
                      : detailRows.slice(0, DETAIL_PAGE)
                    return (
                      <React.Fragment key={row.sample}>
                        <tr
                          className={`scaffold-summary-row ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => loadDetail(row.sample)}
                        >
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {fmtDate(row.date) || '—'}
                          </td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {fmtTime(row.date) || '—'}
                          </td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{row.scaffold_count}</td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{row.gene_count}</td>
                          <td style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 10 }}>
                            {isExpanded ? '▲' : '▼'}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="scaffold-detail-row">
                            <td colSpan={5} style={{ padding: 0 }}>
                              <div className="scaffold-detail-inner expand-anim">
                                {detailStatus === 'loading' && (
                                  <div style={{ padding: '12px 16px', font: '12px var(--mono)', color: 'var(--text-dim)' }}>
                                    Loading scaffolds…
                                  </div>
                                )}
                                {detailStatus === 'ok' && detailRows.length === 0 && (
                                  <div style={{ padding: '12px 16px', font: '12px var(--mono)', color: 'var(--text-dim)' }}>
                                    No individual scaffolds found.
                                  </div>
                                )}
                                {detailStatus === 'ok' && detailRows.length > 0 && (<>
                                  <div className="scaffold-detail-label">
                                    {detailRows.length} scaffold{detailRows.length !== 1 ? 's' : ''} in this sample
                                  </div>
                                  <table className="scaffold-detail-table">
                                    <thead>
                                      <tr>
                                        <th>Scaffold</th>
                                        <th>Gene count</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {visibleDetail.map((d, i) => (
                                        <tr key={i}>
                                          <td style={{ fontFamily: 'var(--mono)', fontSize: 11, wordBreak: 'break-all' }}>{d.scaffold}</td>
                                          <td style={{ fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'right' }}>{d.count}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  {detailRows.length > DETAIL_PAGE && !detailShowAll && (
                                    <button
                                      className="scaffold-show-more"
                                      onClick={e => { e.stopPropagation(); setDetailShowAll(true) }}
                                    >
                                      Show all {detailRows.length} scaffolds ↓
                                    </button>
                                  )}
                                </>)}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
 
          </>)}
        </div>
      </div>
    </div>
  )
}
// ── Scaffold Button (reusable) ─────────────────────────────────────────────

function ScaffoldBtn({
    annotationId, source, onGoExplore,
  }: {
    annotationId:  string
    source:        string
    onGoExplore?:  (annotationId: string, source: string) => void
  }) {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button
          className="btn sm ghost"
          style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 8px' }}
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

// ── Right column single chart card ─────────────────────────────────────────

function RightSingleCard({
  card, seriesCache, onRemove, onAddAnnotation, onGoExplore, uiMode,
}: {
  card:            Extract<RightCard, { kind: 'single' }>
  seriesCache:     SeriesCache
  onRemove:        () => void
  onAddAnnotation: (annotationId: string, source: string, name: string | null) => void
  onGoExplore:     (annotationId: string, source: string) => void
  uiMode:          UiMode
}) {
  const cached = seriesCache[card.key]

  // Quick stats from cached data — O(n) but only computed once per card mount
  const quickStats = useMemo(() => {
    if (cached?.status !== 'ok' || !cached.data.length) return null
    const vals = cached.data.map(d => extractEgc(d.value)).filter((v): v is number => v !== null)
    if (!vals.length) return null
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    return { mean, n: vals.length }
  }, [cached])

  return (
    <div className="al-right-card">
      <div className="al-right-card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: card.color, flexShrink: 0 }} />
          <span className="al-right-card-id">{card.annotationId}</span>
          <span className={`tag ${SOURCE_TAG_CLS[card.source] ?? ''}`}>{card.source}</span>
          {card.name && <span className="al-right-card-name">— {card.name}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {quickStats && (
            <span style={{ font: '400 11px var(--mono)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
              mean {quickStats.mean.toExponential(2)} · {quickStats.n} samples
            </span>
          )}
         <AnnotationInfoDrawer
            annotationId={card.annotationId}
            source={card.source}
            name={card.name}
            parent={card.parent}
          />
          <ScaffoldBtn
            annotationId={card.annotationId}
            source={card.source}
            onGoExplore={onGoExplore}
          />
          <button className="al-card-close" onClick={onRemove} title="Remove chart">×</button>
        </div>
      </div>

      {/* Info drawer sits below header when open */}
      {cached?.status === 'loading' && (
        <div className="state-box" style={{ padding: 20 }}><span>Loading time series…</span></div>
      )}
      {cached?.status === 'error' && (
        <div className="state-box error" style={{ padding: 20 }}><span>Failed to load.</span></div>
      )}
      {cached?.status === 'ok' && (
        <>
          <ChartErrorBoundary label={card.annotationId}>
            <EgcChart
              data={cached.data}
              annotationId={card.annotationId}
              annotationName={card.name}
              color={card.color}
              source={card.source}
              uiMode={uiMode}
            />
          </ChartErrorBoundary>
          <AdvancedOnly mode={uiMode}>
            <MappingsPanel annotationId={card.annotationId} source={card.source} />
          </AdvancedOnly>
          <AdvancedOnly mode={uiMode}>
            <CorrelatesPanel
              annotationId={card.annotationId}
              source={card.source}
              onAddAnnotation={onAddAnnotation}
            />
            <MappingsPanel annotationId={card.annotationId} source={card.source} />
          </AdvancedOnly>
        </>
      )}
    </div>
  )
}

// ── Right column group chart card ──────────────────────────────────────────

function RightGroupCard({
  card, seriesCache, onRemove,
}: {
  card:        Extract<RightCard, { kind: 'group' }>
  seriesCache: SeriesCache
  onRemove:    () => void
}) {
  const allSeries = card.annotationIds.map((id, i) => ({
    annotationId: id,
    name:         null,
    data:         seriesCache[`${id}::${card.sources[i]}`]?.data ?? [],
    color:        SOURCE_COLORS[card.sources[i]] ?? CHART_COLORS[i % CHART_COLORS.length],
  })).filter(s => s.data.length > 0)

  const loading = card.annotationIds.some(
    (id, i) => seriesCache[`${id}::${card.sources[i]}`]?.status === 'loading'
  )

  return (
    <div className="al-right-card al-right-card-group">
      <div className="al-right-card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 14, color: 'var(--teal)', flexShrink: 0 }}>∑</span>
          <span className="al-right-card-id">Grouped: {card.label}</span>
          <span className="tag" style={{ background: 'var(--teal-dim)', color: 'var(--teal)', borderColor: 'rgba(61,217,184,.22)', flexShrink: 0 }}>
            {card.annotationIds.length} annotations
          </span>
        </div>
        <button className="al-card-close" onClick={onRemove} title="Remove chart">×</button>
      </div>
      {/* Compact annotation list */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
        {card.annotationIds.map((id, i) => (
          <span key={id} style={{
            font: '400 10px var(--mono)', color: 'var(--text-dim)',
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 3, padding: '1px 6px',
          }}>
            {id}
          </span>
        ))}
      </div>
      {loading && (
        <div className="state-box" style={{ padding: 20 }}><span>Loading series data…</span></div>
      )}
      {!loading && allSeries.length > 0 && (
        <ChartErrorBoundary label={card.label}>
          <GroupedEgcChart allSeries={allSeries} groupLabel={card.label} />
        </ChartErrorBoundary>
      )}
      {!loading && allSeries.length === 0 && (
        <div className="state-box" style={{ padding: 20 }}><span>No data loaded yet.</span></div>
      )}
    </div>
  )
}

// ── Compare drawer ─────────────────────────────────────────────────────────

function CompareDrawer({
  rightCards, seriesCache, drawerChecked,
  onToggleChecked, onClose, onSendToComparePage,
}: {
  rightCards:          RightCard[]
  seriesCache:         SeriesCache
  drawerChecked:       Set<string>
  onToggleChecked:     (key: string) => void
  onClose:             () => void
  onSendToComparePage: (anns: SharedAnnotation[]) => void
}) {
  const [dateFrom, setDateFrom]   = useState('')
  const [dateTo,   setDateTo]     = useState('')
  const [drawerH,  setDrawerH]    = useState(360)   // px, default height
  const [dragging, setDragging]   = useState(false)
  const dragStartY = useRef(0)
  const dragStartH = useRef(0)
  const drawerRef  = useRef<HTMLDivElement>(null)

  // Drag-to-resize: mousedown on grip → track mousemove on document
  // Drawer is position:fixed so we compute max height from window, not container
  function onGripMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    dragStartY.current = e.clientY
    dragStartH.current = drawerH
    setDragging(true)

    function onMove(ev: MouseEvent) {
      // Moving mouse UP (decreasing clientY) increases drawer height
      const delta = dragStartY.current - ev.clientY
      const maxH  = Math.floor(window.innerHeight * 0.75)
      setDrawerH(Math.max(220, Math.min(maxH, dragStartH.current + delta)))
    }
    function onUp() {
      setDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const eligibleCards = rightCards.filter(c => c.kind === 'single') as Extract<RightCard, { kind: 'single' }>[]
  const activeSeries  = eligibleCards
    .filter(c => drawerChecked.has(c.key) && seriesCache[c.key]?.status === 'ok')
    .map(c => ({
      annotationId: c.annotationId,
      name:         c.name,
      data:         seriesCache[c.key]!.data,
      color:        c.color,
      isGrouped:    false,  // single annotation cards are never grouped in the drawer
    }))

  return (
    <div
      className="al-drawer"
      style={{ height: drawerH }}
      ref={drawerRef}
    >
      {/* Drag resize grip — full-width bar at very top */}
      <div
        className={`al-drawer-resize-grip ${dragging ? 'dragging' : ''}`}
        onMouseDown={onGripMouseDown}
        title="Drag to resize compare panel"
      />

      <div className="al-drawer-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="al-drawer-title">Compare</span>
          <span style={{ font: '10px var(--mono)', color: 'var(--text-dim)' }}>
            drag top edge to resize
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <DateRangePicker
            from={dateFrom} to={dateTo}
            onFrom={setDateFrom} onTo={setDateTo}
            onClear={() => { setDateFrom(''); setDateTo('') }}
          />
          {activeSeries.length > 0 && (
            <button
              className="btn sm"
              onClick={() => onSendToComparePage(
                activeSeries.map(s => {
                  const card = eligibleCards.find(c => c.annotationId === s.annotationId)
                  return { annotationId: s.annotationId, source: card?.source ?? 'kegg', name: s.name }
                })
              )}
              title="Open full Compare page with these annotations"
            >
              → Compare page
            </button>
          )}
          <button className="btn sm ghost" onClick={onClose}>✕ Close</button>
        </div>
      </div>

      <div className="al-drawer-body">
        {/* Checkbox selector */}
        <div className="al-drawer-checklist">
          <div style={{ font: '600 9px var(--mono)', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.14em', marginBottom: 8 }}>
            Include in chart
          </div>
          {eligibleCards.length === 0 && (
            <span style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>
              Add single annotation charts to the right panel first.
            </span>
          )}
          {eligibleCards.map(c => (
            <label key={c.key} className="al-drawer-check-row">
              <input
                type="checkbox"
                checked={drawerChecked.has(c.key)}
                onChange={() => onToggleChecked(c.key)}
              />
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--teal)', flexShrink: 0 }}>{c.annotationId}</span>
              {c.name && <span style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>}
              <span className={`tag ${SOURCE_TAG_CLS[c.source] ?? ''}`} style={{ marginLeft: 'auto', flexShrink: 0 }}>{c.source}</span>
            </label>
          ))}
        </div>

        {/* Multi-line chart */}
        <div className="al-drawer-chart">
          {activeSeries.length < 2 && (
            <div className="state-box" style={{ padding: 24 }}>
              <div className="state-icon">📊</div>
              <span>Check at least 2 annotations on the left to compare them.</span>
            </div>
          )}
          {activeSeries.length >= 2 && (
            <ChartErrorBoundary label="Compare overlay">
              <MultiEgcChart series={activeSeries} dateFrom={dateFrom} dateTo={dateTo} />
            </ChartErrorBoundary>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Analyze Page ───────────────────────────────────────────────────────────

function AnalyzePage({
  state, setState, indexReady, onSendToCompare, onGoScaffoldExplore, uiMode,
}: {
  state:    AnalyzeState
  setState: (updater: (prev: AnalyzeState) => AnalyzeState) => void
  indexReady: boolean
  onSendToCompare: (anns: SharedAnnotation[]) => void
  onGoScaffoldExplore: (annotationId: string, source: string) => void
  uiMode: UiMode
}) {
  const { copiedId, copy } = useCopyId()
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { firstInputRef.current?.focus() }, [])

  // Re-search when index is ready but results lack stats
  useEffect(() => {
    if (!indexReady) return
    const hasResultsWithoutStats = state.resultsByTerm.some(
      rows => rows.length > 0 && rows[0].mean_egc == null
    )
    if (hasResultsWithoutStats) runSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexReady])

  const activeTerms    = state.queryFields.map(q => q.trim()).filter(q => q.length > 0)
  const activeTermIdx  = Math.min(state.activeTermIdx, Math.max(0, activeTerms.length - 1))
  // Stable key for checkedByTerm — term string, not numeric index
  const activeTerm     = activeTerms[activeTermIdx] ?? ''

  // Deduplicated rows for the active term tab
  const uniqueByTerm = useMemo(() =>
    state.resultsByTerm.map(termRows => {
      const seen = new Set<string>()
      return termRows.filter(r => {
        const key = `${r.annotation_id}::${r.source}`
        if (seen.has(key)) return false
        seen.add(key); return true
      })
    }),
  [state.resultsByTerm])

  const activeRows = uniqueByTerm[activeTermIdx] ?? []

  // Keys of all right-column cards (for ✓ indicator on left rows)
  const rightCardKeys = useMemo(
    () => new Set(state.rightCards.filter(c => c.kind === 'single').map(c => c.key)),
    [state.rightCards]
  )

  // Checked keys for the active term tab — keyed by term string, stable across deletions
  const activeChecked = state.checkedByTerm[activeTerm] ?? new Set<string>()

  // ── Series fetcher ─────────────────────────────────────────────────────
  async function fetchSeries(annotationId: string, source: string) {
    const key = `${annotationId}::${source}`
    if (state.seriesCache[key]) return
    setState(prev => ({
      ...prev,
      seriesCache: { ...prev.seriesCache, [key]: { data: [], status: 'loading' } },
    }))
    try {
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/series/annotations?source=${source}&annotation_id=${encodeURIComponent(annotationId)}&page_size=5000`
      )
      setState(prev => ({
        ...prev,
        seriesCache: { ...prev.seriesCache, [key]: { data: json.data ?? [], status: 'ok' } },
      }))
    } catch {
      setState(prev => ({
        ...prev,
        seriesCache: { ...prev.seriesCache, [key]: { data: [], status: 'error' } },
      }))
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────
  async function runSearch() {
    if (activeTerms.length === 0 || state.sources.length === 0) return
    setState(prev => ({
      ...prev,
      searchStatus:  'loading',
      resultsByTerm: [],
      totalsByTerm:  [],
      activeTermIdx: 0,
      checkedByTerm: {}
    }))
    try {
      const src = state.sources.map(s => `sources=${s}`).join('&')
      const responses = await Promise.all(
        activeTerms.map(term =>
          apiFetch<{ data: AnnotationItem[]; total: number }>(
            `/api/search/annotations?q=${encodeURIComponent(term)}&${src}&page_size=5000`
          )
        )
      )
      setState(prev => ({
        ...prev,
        resultsByTerm: responses.map(r => r.data ?? []),
        totalsByTerm:  responses.map(r => r.total ?? r.data?.length ?? 0),
        searchStatus:  'ok',
      }))
    } catch {
      setState(prev => ({ ...prev, searchStatus: 'error' }))
    }
  }

  // ── Left column actions ────────────────────────────────────────────────
  function toggleCheck(key: string) {
    setState(prev => {
      const cur  = new Set(prev.checkedByTerm[activeTerm] ?? [])
      if (cur.has(key)) cur.delete(key); else cur.add(key)
      return { ...prev, checkedByTerm: { ...prev.checkedByTerm, [activeTerm]: cur } }
    })
  }

  function addSingleCard(ann: AnnotationItem) {
    const key = `${ann.annotation_id}::${ann.source}`
    if (state.rightCards.some(c => c.key === key)) return
    const card: RightCard = {
      kind: 'single', key,
      annotationId: ann.annotation_id, source: ann.source,
      name: ann.name, color: nextColorForSource(ann.source),
      parent: (ann as AnnotationItem & { parent?: string | null }).parent ?? null,
    }
    setState(prev => ({
      ...prev,
      rightCards: [...prev.rightCards, card],
      drawerChecked: new Set([...prev.drawerChecked, key]),
    }))
    fetchSeries(ann.annotation_id, ann.source)
  }

  function addSelectedAsIndividual() {
    const rows   = activeRows.filter(r => activeChecked.has(`${r.annotation_id}::${r.source}`))
    const toAdd  = rows.filter(r => !state.rightCards.some(c => c.key === `${r.annotation_id}::${r.source}`))
    if (!toAdd.length) return
    const newCards: RightCard[] = toAdd.map(ann => ({
      kind: 'single' as const, key: `${ann.annotation_id}::${ann.source}`,
      annotationId: ann.annotation_id, source: ann.source, name: ann.name,
      color: nextColorForSource(ann.source),
      parent: (ann as AnnotationItem & { parent?: string | null }).parent ?? null,
    }))
    const newKeys = new Set(newCards.map(c => c.key))
    setState(prev => ({
      ...prev,
      rightCards:    [...prev.rightCards, ...newCards],
      drawerChecked: new Set([...prev.drawerChecked, ...newKeys]),
      checkedByTerm: { ...prev.checkedByTerm, [activeTerm]: new Set() },
    }))
    toAdd.forEach(ann => fetchSeries(ann.annotation_id, ann.source))
  }

  async function addSelectedAsGroup() {
    const termIdx  = Math.min(state.activeTermIdx, Math.max(0, activeTerms.length - 1))
    const termKey  = activeTerms[termIdx] ?? ''
    const checked  = state.checkedByTerm[termKey] ?? new Set<string>()
    const rows     = (uniqueByTerm[termIdx] ?? []).filter(r => checked.has(`${r.annotation_id}::${r.source}`))
    if (rows.length < 2) {
      alert('Select at least 2 annotations to create a group chart.')
      return
    }

    // Cap at 20 to keep fetches manageable — group chart sums all anyway
    const MAX_GROUP = 20
    const capped    = rows.slice(0, MAX_GROUP)
    if (rows.length > MAX_GROUP) {
      alert(`Group capped at ${MAX_GROUP} annotations for performance. Only the first ${MAX_GROUP} will be included.`)
    }

    const termLabel = activeTerms[termIdx] ?? 'group'
    const label = `${termLabel} (${capped.length})`
    const key   = `group::${termLabel}::${Date.now()}`
    const card: RightCard = {
      kind: 'group', key, label,
      annotationIds: capped.map(r => r.annotation_id),
      sources:       capped.map(r => r.source),
    }
    setState(prev => ({
      ...prev,
      rightCards:    [...prev.rightCards, card],
      checkedByTerm: { ...prev.checkedByTerm, [termKey]: new Set() },
    }))

    // Only fetch annotations not already in the cache — avoids redundant requests
    const missing = capped.filter(r => !state.seriesCache[`${r.annotation_id}::${r.source}`])
    await Promise.all(missing.map(ann => fetchSeries(ann.annotation_id, ann.source)))
  }

  function removeCard(cardKey: string) {
    setState(prev => ({
      ...prev,
      rightCards:    prev.rightCards.filter(c => c.key !== cardKey),
      drawerChecked: new Set([...prev.drawerChecked].filter(k => k !== cardKey)),
    }))
  }

  function toggleDrawerCheck(key: string) {
    setState(prev => {
      const next = new Set(prev.drawerChecked)
      if (next.has(key)) next.delete(key); else next.add(key)
      return { ...prev, drawerChecked: next }
    })
  }

  const hasResults = state.searchStatus === 'ok' && state.resultsByTerm.some(r => r.length > 0)

  // All unique rows across all terms — for CSV export
  const allUniqueRows = useMemo(() => {
    const seen = new Set<string>()
    return state.resultsByTerm.flat().filter(r => {
      const key = `${r.annotation_id}::${r.source}`
      if (seen.has(key)) return false
      seen.add(key); return true
    })
  }, [state.resultsByTerm])

  return (
    <div className="page-fade al-page">

      {/* ── Page header ── */}
      <div className="page-header">
        <div className="page-header-left">
          <h1>Analyze Annotations</h1>
          <p className="subtitle">
            Search across all 128 samples · select results to add charts · compare overlays
          </p>
        </div>
      </div>

      {/* ── Search section ── */}
      <div className="al-topbar">
        <div style={{ marginBottom: 8 }}><h2>Search</h2></div>
        <div className="al-search-area">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            {state.queryFields.map((q, idx) => (
              <div key={idx} className="search-bar">
                <input
                  ref={idx === 0 ? firstInputRef : undefined}
                  className="field"
                  placeholder={idx === 0 ? 'e.g. iron, K02014, transport…' : `Term ${idx + 1}`}
                  value={q}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const next = [...state.queryFields]
                    next[idx] = e.target.value
                    setState(prev => ({ ...prev, queryFields: next }))
                  }}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') runSearch()
                  }}
                />
                {state.queryFields.length > 1 && (
                  <button className="btn ghost sm" style={{ flex: 'none' }}
                    onClick={() => setState(prev => ({
                      ...prev,
                      queryFields: prev.queryFields.filter((_, i) => i !== idx),
                    }))}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button className="btn primary" onClick={runSearch} disabled={state.searchStatus === 'loading'}>
              {state.searchStatus === 'loading' ? 'Searching…' : 'Search'}
            </button>
            <button className="btn sm ghost"
              onClick={() => setState(prev => ({ ...prev, queryFields: [...prev.queryFields, ''] }))}
              title="Add another search term — each gets its own tab">
              + Add term
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
          <div className="search-sources">
            {(['kegg', 'cog', 'enzyme', 'taxonomy'] as const).map(src => (
              <label key={src} className={`source-toggle ${state.sources.includes(src) ? 'active' : ''}`}>
                <input type="checkbox" checked={state.sources.includes(src)} onChange={() =>
                  setState(prev => ({
                    ...prev,
                    sources: prev.sources.includes(src)
                      ? prev.sources.filter(x => x !== src)
                      : [...prev.sources, src],
                  }))} />
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: SOURCE_COLORS[src], flexShrink: 0, display: 'inline-block' }} />
                {src}
              </label>
            ))}
          </div>
          <p className="subtitle" style={{ marginLeft: 4 }}>···Click to exclude annotation type</p>
          {hasResults && (
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
              <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                {allUniqueRows.length} unique annotations
              </span>
              <button className="btn sm" onClick={() => downloadCsv(
                allUniqueRows.map(r => ({ annotation_id: r.annotation_id, name: r.name ?? '', source: r.source })),
                `search_results_${activeTerms.join('_')}.csv`
              )}>↓ CSV</button>
            </div>
          )}
        </div>
      </div>

      {/* ── States ── */}
      {state.searchStatus === 'idle' && (
        <FirstRunHint uiMode={uiMode} />
      )}
      {state.searchStatus === 'loading' && (
        <div className="state-box"><span>Searching across all samples…</span></div>
      )}
      {state.searchStatus === 'error' && (
        <div className="state-box error">
          <div className="state-icon">⚠</div>
          <span>Search failed — is the FastAPI server running?</span>
        </div>
      )}
      {state.searchStatus === 'ok' && !hasResults && (
        <div className="state-box">
          <div className="state-icon">∅</div>
          <span>No annotations found for {activeTerms.map(t => `"${t}"`).join(' or ')}</span>
        </div>
      )}

      {/* ── Two-column workspace ── */}
      {hasResults && (
        <div className="al-workspace">

          {/* LEFT COLUMN — search results */}
          <div className="al-left">
            {/* Term tabs */}
            <div className="al-term-tabs">
              {activeTerms.map((term, i) => (
                <button
                  key={i}
                  className={`al-term-tab ${activeTermIdx === i ? 'active' : ''}`}
                  onClick={() => setState(prev => ({ ...prev, activeTermIdx: i }))}
                >
                  {term}
                  <span className="al-tab-count">
                    {state.totalsByTerm[i] ?? uniqueByTerm[i]?.length ?? 0}
                  </span>
                </button>
              ))}
            </div>

            {/* Results list for active term */}
            <LeftResultList
              rows={activeRows}
              termLabel={activeTerms[activeTermIdx] ?? ''}
              checkedKeys={activeChecked}
              seriesCache={state.seriesCache}
              rightCardKeys={rightCardKeys}
              copiedId={copiedId}
              onCopy={copy}
              onToggleCheck={toggleCheck}
              onAddSingle={addSingleCard}
              onAddSelected={addSelectedAsIndividual}
              onGroupSelected={addSelectedAsGroup}
              total={state.totalsByTerm[activeTermIdx] ?? activeRows.length}
            />
          </div>

          {/* RIGHT COLUMN — charts + compare drawer */}
          <div className={`al-right ${state.drawerOpen ? 'al-right-drawer-open' : ''}`}>

            {/* Right column action bar — Compare button lives here */}
            <div className="al-right-actionbar">
              <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                {state.rightCards.length === 0
                  ? 'Click + on results to add charts'
                  : `${state.rightCards.length} chart${state.rightCards.length !== 1 ? 's' : ''} open`}
              </span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {/* Copy all open KEGG IDs + open Color Mapper */}
                {(() => {
                  const keggIds = state.rightCards
                    .filter(c => c.kind === 'single' && c.source === 'kegg')
                    .map(c => (c as Extract<RightCard, { kind: 'single' }>).annotationId)
                  return keggIds.length > 0 ? (
                    <button
                      className="btn sm ghost"
                      title={`Copy ${keggIds.length} KEGG ID${keggIds.length > 1 ? 's' : ''} to clipboard, then open KEGG Color Mapper — paste into Objects box`}
                      onClick={async () => {
                        try { await navigator.clipboard.writeText(keggIds.join('\n')) } catch {}
                        window.open('https://www.genome.jp/kegg/mapper/color.html', '_blank', 'noopener')
                      }}
                    >
                      Color Mapper ({keggIds.length}) ⎘
                    </button>
                  ) : null
                })()}
                <button
                  className={`btn sm ${state.drawerOpen ? 'primary' : ''}`}
                  onClick={() => setState(prev => ({ ...prev, drawerOpen: !prev.drawerOpen }))}
                  disabled={state.rightCards.filter(c => c.kind === 'single').length < 2}
                  title={
                    state.rightCards.filter(c => c.kind === 'single').length < 2
                      ? 'Add at least 2 single annotation charts to compare'
                      : 'Toggle overlay comparison chart'
                  }
                >
                  {state.drawerOpen ? '▼ Close Compare' : '▲ Compare'}
                </button>
              </div>
            </div>

            {/* Scrollable chart cards */}
            <div className="al-right-cards">
              {state.rightCards.length === 0 && (
                <div className="state-box" style={{ padding: '48px 24px' }}>
                  <div className="state-icon">📈</div>
                  <span>Click <strong>+</strong> on any result to add its chart here, or check multiple rows and use <strong>+ Add N</strong>.</span>
                </div>
              )}
              {state.rightCards.map(card => (
                card.kind === 'single'
                  ? <RightSingleCard
                      key={card.key}
                      card={card}
                      seriesCache={state.seriesCache}
                      uiMode={uiMode}
                      onRemove={() => removeCard(card.key)}
                      onGoExplore={onGoScaffoldExplore}
                      onAddAnnotation={(annId, src, name) => {
                        addSingleCard({ annotation_id: annId, source: src, name, sample: '', timepoint: null, value: null } as AnnotationItem)
                      }}
                    />

                  : <RightGroupCard
                      key={card.key}
                      card={card}
                      seriesCache={state.seriesCache}
                      onRemove={() => removeCard(card.key)}
                    />
              ))}
            </div>

            {/* Compare drawer — slides up from bottom of right column */}
            {state.drawerOpen && (
              <CompareDrawer
                rightCards={state.rightCards}
                seriesCache={state.seriesCache}
                drawerChecked={state.drawerChecked}
                onToggleChecked={toggleDrawerCheck}
                onClose={() => setState(prev => ({ ...prev, drawerOpen: false }))}
                onSendToComparePage={onSendToCompare}
              />
            )}
          </div>

        </div>
      )}
    </div>
  )
}

// ── Explore Page state ─────────────────────────────────────────────────────

type ExploreSection = 'overview' | 'top-egc' | 'by-parent' | 'lookup' | 'scaffolds'
type ExploreSortCol = 'mean_egc' | 'max_egc' | 'sample_count' | 'annotation_id'

type ExploreState = {
  openSection:  ExploreSection | null
  source:       string
  limit:        number
  dateFrom:     string
  dateTo:       string
  rows:         TopAnnotation[]
  sampleCount:  number | null
  status:       ApiStatus
  sortCol:      ExploreSortCol
  sortDir:      SortDir
  parentSource: string
  topFilter:    string
  // Lookup section
  lookupId:       string
  lookupSource:   string
  lookupResults:  TopAnnotation[]   // list of matches (general search or exact)
  lookupSelected: TopAnnotation | null  // clicked result for detail view
  lookupTotal:    number
  lookupStatus:        ApiStatus
  scaffoldInitialTerms?: { annotationId: string; source: string }[]
}

function makeDefaultExploreState(): ExploreState {
  return {
    openSection: null, source: 'kegg', limit: 25,
    dateFrom: '', dateTo: '', rows: [], sampleCount: null, status: 'idle',
    sortCol: 'mean_egc', sortDir: 'desc', parentSource: 'kegg', topFilter: '',
    lookupId: '', lookupSource: 'kegg',
    lookupResults: [], lookupSelected: null, lookupTotal: 0, lookupStatus: 'idle',
    scaffoldInitialTerms: undefined,
  }
}

// ── Compare Page state ─────────────────────────────────────────────────────

type CompareEntry = {
  annotationId: string; source: string; name: string | null
  data: AnnotationItem[]; status: ApiStatus; color: string
}

type CompareState = {
  query:         string
  querySource:   string
  searchResults: AnnotationItem[]
  searchStatus:  ApiStatus
  entries:       CompareEntry[]
  showMappings:  boolean
  dateFrom:      string
  dateTo:        string
}

function makeDefaultCompareState(): CompareState {
  return {
    query: '', querySource: 'kegg', searchResults: [],
    searchStatus: 'idle', entries: [], showMappings: false,
    dateFrom: '', dateTo: '',
  }
}

// ── Dataset Overview Panel ─────────────────────────────────────────────────

function DatasetOverviewPanel({ resetKey, dataDateRange }: {
  resetKey: number
  dataDateRange: { min: string; max: string } | null
}) {
  const [source, setSource]               = useState('kegg')
  const [dateFrom, setDateFrom]           = useState('')
  const [dateTo, setDateTo]               = useState('')
  const [rows, setRows]                   = useState<TopAnnotation[]>([])
  const [sampleCount, setSampleCount]     = useState<number | null>(null)
  const [status, setStatus]               = useState<ApiStatus>('idle')
  const [seriesData, setSeriesData]       = useState<Record<string, AnnotationItem[]>>({})
  const [seriesStatus, setSeriesStatus]   = useState<ApiStatus>('idle')
  const chartRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSource('kegg'); setDateFrom(''); setDateTo('')
    setRows([]); setSampleCount(null); setStatus('idle')
    setSeriesData({}); setSeriesStatus('idle')
  }, [resetKey])

  async function load() {
    setStatus('loading')
    setSeriesData({}); setSeriesStatus('idle')
    try {
      let url = `/api/annotations/top?source=${source}&limit=200`
      if (dateFrom) url += `&date_from=${dateFrom}`
      if (dateTo)   url += `&date_to=${dateTo}`
      const r = await apiFetch<{ data: TopAnnotation[]; sample_count: number }>(url)
      setRows(r.data ?? [])
      setSampleCount(r.sample_count)
      setStatus('ok')
    } catch { setStatus('error') }
  }

  const parentGroups = useMemo(() => {
    const map = new Map<string, TopAnnotation[]>()
    for (const r of rows) {
      const key = r.parent ?? 'Ungrouped'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return Array.from(map.entries())
      .map(([parent, items]) => ({
        parent,
        label:  expandParentLabel(parent, source),
        sumEgc: items.reduce((s, i) => s + i.mean_egc, 0),
        count:  items.length,
        items,
      }))
      .sort((a, b) => b.sumEgc - a.sumEgc)
  }, [rows, source])

  const top5Groups = parentGroups.slice(0, 5)

  async function loadTemporalChart() {
    const allAnns = top5Groups.flatMap(g => g.items).slice(0, 40)
    if (!allAnns.length) return
    setSeriesStatus('loading')
    try {
      const results = await Promise.all(
        allAnns.map(ann =>
          apiFetch<{ data: AnnotationItem[] }>(
            `/api/series/annotations?source=${source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=5000`
          ).then(r => ({ id: ann.annotation_id, data: r.data ?? [] }))
           .catch(() => ({ id: ann.annotation_id, data: [] as AnnotationItem[] }))
        )
      )
      const map: Record<string, AnnotationItem[]> = {}
      for (const { id, data } of results) map[id] = data
      setSeriesData(map)
      setSeriesStatus('ok')
    } catch { setSeriesStatus('error') }
  }

  const CHART_GROUP_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--amber)']

  const temporalSeries = useMemo(() => {
    if (!Object.keys(seriesData).length) return []
    return top5Groups.map((group, gi) => ({
      annotationId: group.label,
      name:         group.label,
      color:        CHART_GROUP_COLORS[gi],
      data:         group.items.flatMap(ann => {
        const annData = seriesData[ann.annotation_id] ?? []
        return annData.map(d => ({ ...d, annotation_id: group.label }))
      }),
    }))
  }, [seriesData, top5Groups])

  const overviewStats = useMemo(() => {
    if (!rows.length) return null
    return computeStats(rows.map(r => r.mean_egc))
  }, [rows])

  return (
    <div style={{ padding: '20px 24px 24px' }}>
      <div style={{ marginBottom: 14 }}><h2>Dataset Overview</h2></div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <select className="field" style={{ width: 140 }} value={source}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSource(e.target.value)}>
          {(['kegg', 'cog', 'enzyme', 'taxonomy'] as const).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <DateRangePicker from={dateFrom} to={dateTo} onFrom={setDateFrom} onTo={setDateTo}
          onClear={() => { setDateFrom(''); setDateTo('') }}
          minDate={dataDateRange?.min} maxDate={dataDateRange?.max} />
        <button className="btn primary" onClick={load} disabled={status === 'loading'}>
          {status === 'loading' ? 'Loading…' : 'Load Overview'}
        </button>
        {status === 'ok' && rows.length > 0 && (
          <button className="btn sm"
            onClick={() => downloadCsv(rows.map(r => ({ ...r, source })), `overview_${source}.csv`)}>
            ↓ CSV
          </button>
        )}
      </div>

      {status === 'idle' && (
        <div className="state-box" style={{ padding: 32 }}>
          <div className="state-icon">🔬</div>
          <span>Select a source type and click Load Overview.</span>
        </div>
      )}
      {status === 'loading' && (
        <div className="state-box" style={{ padding: 32 }}><span>Loading dataset…</span></div>
      )}
      {status === 'error' && (
        <div className="state-box error" style={{ padding: 32 }}>
          <div className="state-icon">⚠</div><span>Failed to load.</span>
        </div>
      )}

      {status === 'ok' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>{rows.length}</span>
            {' '}unique {source} annotations ·{' '}
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>{sampleCount}</span>
            {' '}samples ·{' '}
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>{parentGroups.length}</span>
            {' '}functional groups
            {dateFrom || dateTo ? ` · ${dateFrom || '…'} → ${dateTo || '…'}` : ' · all dates'}
          </div>

          {overviewStats && (
            <StatsPanel vals={rows.map(r => r.mean_egc)} yLabel={`Mean EGC distribution · ${source}`} />
          )}

          <div>
            <div style={{
              font: '600 11px var(--mono)', color: 'var(--text-dim)',
              textTransform: 'uppercase', letterSpacing: '.14em', marginBottom: 12,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span>Top Functional Groups by Σ Mean EGC</span>
              {seriesStatus === 'idle' && (
                <button className="btn sm" onClick={loadTemporalChart}>
                  Load time series →
                </button>
              )}
              {seriesStatus === 'loading' && (
                <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>Loading time series…</span>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {parentGroups.slice(0, 10).map((group, i) => {
                const maxSum = parentGroups[0]?.sumEgc ?? 1
                const color  = CHART_GROUP_COLORS[i] ?? 'var(--text-dim)'
                return (
                  <div key={group.parent} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)', width: 18, textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                    <span style={{ font: '500 12px var(--mono)', color: i < 5 ? color : 'var(--text-dim)', width: 240, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={group.label}>
                      {group.label}
                    </span>
                    <div style={{ flex: 1, height: 8, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 2,
                        width: `${(group.sumEgc / maxSum) * 100}%`,
                        background: i < 5 ? color : 'var(--text-dim)',
                        opacity: i < 5 ? 1 : 0.4,
                      }} />
                    </div>
                    <span style={{ font: '400 11px var(--mono)', color: 'var(--text-dim)', width: 88, textAlign: 'right', flexShrink: 0 }}>
                      {group.sumEgc.toExponential(2)}
                    </span>
                    <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)', width: 60, textAlign: 'right', flexShrink: 0 }}>
                      {group.count} ann
                    </span>
                  </div>
                )
              })}
            </div>

            {seriesStatus === 'ok' && temporalSeries.length > 0 && (
              <div ref={chartRef}>
                <div style={{ font: '600 11px var(--mono)', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.14em', marginBottom: 10 }}>
                  Summed EGC over time — top 5 functional groups
                </div>
                <ChartErrorBoundary label="Explore temporal chart">
                  <MultiEgcChart series={temporalSeries} dateFrom={dateFrom} dateTo={dateTo} />
                </ChartErrorBoundary>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ExploreSortTh({
  col, label, sortCol, sortDir, onSort,
}: {
  col: ExploreSortCol; label: string
  sortCol: ExploreSortCol; sortDir: SortDir
  onSort: (col: ExploreSortCol) => void
}) {
  return (
    <th
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}
      <span style={{ marginLeft: 4, opacity: sortCol === col ? 1 : 0.3 }}>
        {sortCol === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  )
}

function AnnotationsByParentPanel({ source }: { source: string }) {
  const [allRows, setAllRows]         = useState<TopAnnotation[]>([])
  const [status, setStatus]           = useState<ApiStatus>('idle')
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [showSummed, setShowSummed]   = useState(false)
  const [groupSeriesData, setGroupSeriesData] = useState<Record<string, { data: Record<string, AnnotationItem[]>; status: ApiStatus }>>({})
  const { copiedId, copy } = useCopyId()

  useEffect(() => {
    setStatus('loading')
    setAllRows([])
    setExpandedParents(new Set())
    setGroupSeriesData({})
    apiFetch<{ data: TopAnnotation[] }>(`/api/annotations/top?source=${source}&limit=200`)
      .then(r => { setAllRows(r.data ?? []); setStatus('ok') })
      .catch(() => setStatus('error'))
  }, [source])

  const parentGroups = useMemo(() => {
    const map = new Map<string, TopAnnotation[]>()
    for (const r of allRows) {
      const key = r.parent ?? 'Ungrouped'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return Array.from(map.entries())
      .map(([parent, items]) => ({
        parent,
        label:  expandParentLabel(parent, source),
        items:  items.sort((a, b) => b.mean_egc - a.mean_egc),
        sumEgc: items.reduce((s, i) => s + i.mean_egc, 0),
        count:  items.length,
      }))
      .sort((a, b) => b.sumEgc - a.sumEgc)
  }, [allRows, source])

  function toggleParent(p: string) {
    setExpandedParents(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p); else next.add(p)
      return next
    })
  }

  async function loadGroupSeries(parent: string, items: TopAnnotation[]) {
    if (groupSeriesData[parent]) return
    setGroupSeriesData(prev => ({ ...prev, [parent]: { data: {}, status: 'loading' } }))
    try {
      const results = await Promise.all(
        items.slice(0, 20).map(ann =>
          apiFetch<{ data: AnnotationItem[] }>(
            `/api/series/annotations?source=${source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=5000`
          ).then(r => ({ id: ann.annotation_id, data: r.data ?? [] }))
           .catch(() => ({ id: ann.annotation_id, data: [] as AnnotationItem[] }))
        )
      )
      const map: Record<string, AnnotationItem[]> = {}
      for (const { id, data } of results) map[id] = data
      setGroupSeriesData(prev => ({ ...prev, [parent]: { data: map, status: 'ok' } }))
    } catch {
      setGroupSeriesData(prev => ({ ...prev, [parent]: { data: {}, status: 'error' } }))
    }
  }

  if (status === 'loading') return <div className="state-box" style={{ padding: 32 }}><span>Loading annotations…</span></div>
  if (status === 'error')   return <div className="state-box error" style={{ padding: 32 }}><span>Failed to load.</span></div>
  if (status === 'ok' && parentGroups.length === 0) return <div className="state-box" style={{ padding: 32 }}><span>No parent groupings found for {source}.</span></div>

  const maxSum = parentGroups[0]?.sumEgc ?? 1

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ font: '400 11px var(--mono)', color: 'var(--text-dim)' }}>View:</span>
        <button className={`toggle-pill ${!showSummed ? 'on' : ''}`} onClick={() => setShowSummed(false)}>
          Individual annotations
        </button>
        <button className={`toggle-pill ${showSummed ? 'on' : ''}`} onClick={() => setShowSummed(true)}
          title="Collapse each parent group into its summed mean EGC">
          ∑ Summed EGC by parent
        </button>
      </div>

      {showSummed && (
        <table className="ann-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>#</th>
              <th>Parent / Category</th>
              <th>Annotations</th>
              <th>Σ Mean EGC</th>
              <th>Relative</th>
            </tr>
          </thead>
          <tbody>
            {parentGroups.map((g, i) => (
              <tr key={g.parent}>
                <td style={{ font: '400 12px var(--mono)', color: 'var(--text-dim)' }}>{i + 1}</td>
                <td className="name-cell" style={{ fontWeight: 600 }}>{g.label}</td>
                <td style={{ font: '400 12px var(--mono)', color: 'var(--text-dim)' }}>{g.count}</td>
                <td style={{ font: '500 12px var(--mono)', color: 'var(--teal)' }}>{g.sumEgc.toExponential(2)}</td>
                <td style={{ minWidth: 100 }}>
                  <div style={{ height: 6, borderRadius: 3, background: `linear-gradient(90deg, var(--teal) ${(g.sumEgc / maxSum) * 100}%, var(--surface2) 0%)`, minWidth: 4 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!showSummed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {parentGroups.map(group => {
            const isOpen    = expandedParents.has(group.parent)
            const gs        = groupSeriesData[group.parent]
            const chartSeries = isOpen && gs?.status === 'ok'
              ? group.items.slice(0, 20).map(ann => ({
                  annotationId: ann.annotation_id,
                  name:         ann.name,
                  data:         gs.data[ann.annotation_id] ?? [],
                  color:        SOURCE_COLORS[source] ?? 'var(--chart-1)',
                })).filter(s => s.data.length > 0)
              : []

            return (
              <div key={group.parent} className="parent-group">
                <button
                  className={`mappings-toggle ${isOpen ? 'open' : ''}`}
                  onClick={() => {
                    toggleParent(group.parent)
                    if (!isOpen) loadGroupSeries(group.parent, group.items)
                  }}
                  style={{ padding: '12px 16px', background: 'var(--surface2)', borderRadius: isOpen ? '8px 8px 0 0' : 8 }}
                >
                  <span className="toggle-icon">▶</span>
                  <span className="toggle-label" style={{ fontWeight: 600, color: 'var(--text-h)' }}>
                    {group.label}
                  </span>
                  <span className="toggle-count">
                    {group.count} annotations · Σ {group.sumEgc.toExponential(2)}
                  </span>
                </button>

                {isOpen && (
                  <div className="expand-anim" style={{ borderTop: '1px solid var(--border)', padding: '16px 20px' }}>
                    {gs?.status === 'loading' && (
                      <div className="state-box" style={{ padding: 20 }}>
                        <span>Loading time series for {group.count} annotations…</span>
                      </div>
                    )}
                    {gs?.status === 'error' && (
                      <div className="state-box error" style={{ padding: 20 }}>
                        <span>Failed to load time series.</span>
                      </div>
                    )}
                    {gs?.status === 'ok' && chartSeries.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <GroupedEgcChart allSeries={chartSeries} groupLabel={group.label} />
                      </div>
                    )}

                    <table className="ann-table" style={{ borderRadius: 6 }}>
                      <thead>
                        <tr>
                          <th>Annotation ID</th>
                          <th>Name</th>
                          <th>Mean EGC</th>
                          <th>Samples</th>
                          <th title="Δ EGC (raw): mean of last quarter of timepoints minus mean of first quarter. Always in raw EGC units regardless of chart normalisation.">
                            Trend Δ EGC
                          </th>
                          <th>Scaffolds</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map(row => {
                          const seriesVals = (gs?.data?.[row.annotation_id] ?? [])
                            .map(d => extractEgc(d.value))
                            .filter((v): v is number => v !== null)
                          const trend = computeTrend(seriesVals)
                          return (
                            <tr key={row.annotation_id}>
                              <td className="id-cell">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <CopyBtn id={row.annotation_id} copiedId={copiedId} onCopy={copy} />
                                  {row.annotation_id}
                                </div>
                              </td>
                              <td className="name-cell">{row.name ?? '—'}</td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{row.mean_egc.toExponential(2)}</td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{row.sample_count}</td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
                                {trend === null ? (
                                  <span style={{ color: 'var(--text-dim)' }}>—</span>
                                ) : trend > 0 ? (
                                  <span
                                    style={{ color: 'var(--teal)' }}
                                    title={`+${trend.toExponential(2)} EGC (raw) — last-quarter mean minus first-quarter mean`}
                                  >
                                    ↑ {trend.toExponential(2)}
                                  </span>
                                ) : (
                                  <span
                                    style={{ color: 'var(--coral)' }}
                                    title={`${trend.toExponential(2)} EGC (raw) — last-quarter mean minus first-quarter mean`}
                                  >
                                    ↓ {Math.abs(trend).toExponential(2)}
                                  </span>
                                )}
                              </td>
                              <td>
                                <ScaffoldBtn annotationId={row.annotation_id} source={source} />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
 type ScaffoldExploreTerm = {
    annotationId: string
    source:       string
    summary:      ScaffoldSummaryRow[]
    status:       ApiStatus
    color:        string
    expanded:     boolean
  }
 
  function ScaffoldExplorePanel({
    initialTerms,
  }: {
    initialTerms?: { annotationId: string; source: string }[]
  }) {
    const TERM_COLORS = [
      'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
      'var(--amber)', '#a78bfa', '#34d399', '#f472b6',
    ]
    const [terms, setTerms]               = useState<ScaffoldExploreTerm[]>([])
    const [searchQ, setSearchQ]           = useState('')
    const [searchSrc, setSearchSrc]       = useState('cog')
    const [searchRes, setSearchRes]       = useState<TopAnnotation[]>([])
    const [searchStatus, setSearchStatus] = useState<ApiStatus>('idle')
    const [dateFrom, setDateFrom]         = useState('')
    const [dateTo, setDateTo]             = useState('')
    const [chartMetric, setChartMetric]   = useState<'scaffold_count' | 'gene_count'>('scaffold_count')
    const [chartType, setChartType]       = useState<'line' | 'bar'>('line')
    const [splitByTerm, setSplitByTerm]   = useState(false)
    const [topStatus, setTopStatus]       = useState<ApiStatus>('idle')
 
    useEffect(() => {
      if (initialTerms?.length) {
        initialTerms.forEach(t => addTerm(t.annotationId, t.source))
      } else {
        loadTopTerms()
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
 
    async function loadTopTerms() {
      setTopStatus('loading')
      try {
        const r = await apiFetch<{ data: TopAnnotation[] }>(
          `/api/annotations/top?source=cog&limit=25`
        )
        setTopStatus('ok')
        ;(r.data ?? []).slice(0, 5).forEach(ann => addTerm(ann.annotation_id, 'cog'))
      } catch { setTopStatus('error') }
    }
 
    async function addTerm(annotationId: string, source: string) {
      setTerms(prev => {
        if (prev.some(t => t.annotationId === annotationId && t.source === source)) return prev
        const color = TERM_COLORS[prev.length % TERM_COLORS.length]
        return [...prev, { annotationId, source, summary: [], status: 'loading', color, expanded: false }]
      })
      try {
        const r = await apiFetch<{ data: ScaffoldSummaryRow[] }>(
          `/api/annotations/scaffolds/summary?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`
        )
        setTerms(prev => prev.map(t =>
          t.annotationId === annotationId && t.source === source
            ? { ...t, summary: r.data ?? [], status: 'ok' }
            : t
        ))
      } catch {
        setTerms(prev => prev.map(t =>
          t.annotationId === annotationId && t.source === source
            ? { ...t, status: 'error' }
            : t
        ))
      }
    }
 
    function removeTerm(annotationId: string, source: string) {
      setTerms(prev => prev.filter(t => !(t.annotationId === annotationId && t.source === source)))
    }
 
    async function runSearch() {
      if (!searchQ.trim()) return
      setSearchStatus('loading')
      try {
        const r = await apiFetch<{ data: TopAnnotation[] }>(
          `/api/search/annotations?q=${encodeURIComponent(searchQ)}&sources=${searchSrc}&page_size=20`
        )
        setSearchRes(r.data ?? [])
        setSearchStatus('ok')
      } catch { setSearchStatus('error') }
    }
 
    const chartSeries = useMemo(() => {
      const readyTerms = terms.filter(t => t.status === 'ok' && t.summary.length > 0)
      if (!readyTerms.length) return []
      if (splitByTerm) {
        return readyTerms.map(term => ({
          id:    term.annotationId,
          label: term.annotationId,
          color: term.color,
          data:  term.summary
            .filter(r => {
              if (dateFrom && r.date < dateFrom) return false
              if (dateTo   && r.date > dateTo)   return false
              return true
            })
            .sort((a, b) => a.date.localeCompare(b.date)),
        }))
      }
      const dateMap: Record<string, { scaffold_count: number; gene_count: number; date: string }> = {}
      for (const term of readyTerms) {
        for (const row of term.summary) {
          if (dateFrom && row.date < dateFrom) continue
          if (dateTo   && row.date > dateTo)   continue
          if (!dateMap[row.date]) dateMap[row.date] = { scaffold_count: 0, gene_count: 0, date: row.date }
          dateMap[row.date].scaffold_count += row.scaffold_count
          dateMap[row.date].gene_count     += row.gene_count
        }
      }
      return [{
        id: 'aggregated',
        label: `All terms (${readyTerms.length})`,
        color: 'var(--chart-1)',
        data: Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date)),
      }]
    }, [terms, dateFrom, dateTo, splitByTerm])
 
    const chartRows = useMemo(() => {
      const dateSet = new Set<string>()
      for (const s of chartSeries) for (const d of s.data) dateSet.add(d.date)
      return Array.from(dateSet).sort().map(date => {
        const row: Record<string, string | number> = { date }
        for (const s of chartSeries) {
          const found = s.data.find(d => d.date === date)
          row[s.id] = found ? found[chartMetric] : 0
        }
        return row
      })
    }, [chartSeries, chartMetric])
 
    return (
      <div style={{ padding: '20px 24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div><h2>Scaffold Information</h2></div>
 
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="field" style={{ width: 130 }}
            value={searchSrc}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSearchSrc(e.target.value)}
          >
            {['cog', 'enzyme', 'taxonomy'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            className="field"
            placeholder="Search annotation ID or name…"
            value={searchQ}
            style={{ flex: 1, minWidth: 200, maxWidth: 360 }}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQ(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') runSearch() }}
          />
          <button className="btn primary" onClick={runSearch} disabled={searchStatus === 'loading'}>
            {searchStatus === 'loading' ? 'Searching…' : 'Search'}
          </button>
          <DateRangePicker
            from={dateFrom} to={dateTo}
            onFrom={setDateFrom} onTo={setDateTo}
            onClear={() => { setDateFrom(''); setDateTo('') }}
          />
        </div>
 
        {searchStatus === 'ok' && searchRes.length > 0 && (
          <div style={{
            border: '1px solid var(--border)', borderRadius: 7,
            background: 'var(--surface)', overflow: 'hidden', maxHeight: 260, overflowY: 'auto',
          }}>
            <div style={{
              padding: '6px 12px', font: '10px var(--mono)', color: 'var(--text-dim)',
              background: 'var(--surface3)', borderBottom: '1px solid var(--border)',
            }}>
              {searchRes.length} results — click to add
            </div>
            {searchRes.map(r => {
              const already = terms.some(t => t.annotationId === r.annotation_id)
              return (
                <div
                  key={r.annotation_id}
                  onClick={() => !already && addTerm(r.annotation_id, searchSrc)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 14px', cursor: already ? 'default' : 'pointer',
                    opacity: already ? 0.5 : 1, borderBottom: '1px solid var(--border)',
                  }}
                  onMouseEnter={e => { if (!already) e.currentTarget.style.background = 'var(--surface2)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = '' }}
                >
                  <span style={{ font: '600 12px var(--mono)', color: 'var(--teal)' }}>{r.annotation_id}</span>
                  <span style={{ font: '13px var(--sans)', color: 'var(--text-dim)', flex: 1 }}>{r.name ?? '—'}</span>
                  <span style={{ font: '11px var(--mono)', color: already ? 'var(--text-dim)' : 'var(--teal)' }}>
                    {already ? 'added' : '+'}
                  </span>
                </div>
              )
            })}
          </div>
        )}
 
        {topStatus === 'loading' && terms.length === 0 && (
          <div className="state-box" style={{ padding: 24 }}><span>Loading top annotations…</span></div>
        )}
 
        {terms.length > 0 && (
          <div className="scaffold-summary-card">
            {terms.map(term => (
              <div key={`${term.annotationId}::${term.source}`} className="scaffold-summary-card-row">
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: term.color, flexShrink: 0 }} />
                <span style={{ font: '600 12px var(--mono)', color: 'var(--teal)', minWidth: 80 }}>{term.annotationId}</span>
                <span className={`tag ${SOURCE_TAG_CLS[term.source] ?? ''}`}>{term.source}</span>
                {term.status === 'loading' && <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>loading…</span>}
                {term.status === 'ok' && (
                  <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                    {term.summary.length} samples · max {Math.max(...term.summary.map(r => r.scaffold_count))} scaffolds ·{' '}
                    max {Math.max(...term.summary.map(r => r.gene_count))} genes
                  </span>
                )}
                <button className="al-card-close" style={{ marginLeft: 'auto' }}
                  onClick={() => removeTerm(term.annotationId, term.source)}>×</button>
              </div>
            ))}
          </div>
        )}
 
        {terms.some(t => t.status === 'ok') && (
          <div className="chart-card">
            <div className="chart-card-header">
              <div className="chart-card-title">
                {chartMetric === 'scaffold_count' ? 'Scaffold count' : 'Gene count'} over time
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className={`toggle-pill sm ${chartMetric === 'scaffold_count' ? 'on' : ''}`}
                  onClick={() => setChartMetric('scaffold_count')}>Scaffolds</button>
                <button className={`toggle-pill sm ${chartMetric === 'gene_count' ? 'on' : ''}`}
                  onClick={() => setChartMetric('gene_count')}>Genes</button>
                <button className={`toggle-pill sm ${chartType === 'line' ? 'on' : ''}`}
                  onClick={() => setChartType('line')}>Line</button>
                <button className={`toggle-pill sm ${chartType === 'bar' ? 'on' : ''}`}
                  onClick={() => setChartType('bar')}>Bar</button>
                {terms.length > 1 && (
                  <button className={`toggle-pill sm ${splitByTerm ? 'on' : ''}`}
                    onClick={() => setSplitByTerm(s => !s)}
                    title="One line per term instead of aggregated">Split by term</button>
                )}
              </div>
            </div>
            <div className="chart-legend" style={{ marginBottom: 10 }}>
              {chartSeries.map(s => (
                <div className="legend-item" key={s.id}>
                  <div className="legend-dot" style={{ background: s.color }} />
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={chartRows} margin={{ top: 6, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="" stroke="#d9d9d9" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)' }}
                  tickLine={false} axisLine={{ stroke: 'var(--border)' }}
                  angle={-35} textAnchor="end" height={44}
                  tickFormatter={(v: string) => fmtDate(v)}
                  interval={Math.max(1, Math.floor(chartRows.length / 8))}
                />
                <YAxis
                  tick={{ fill: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)' }}
                  tickLine={false} axisLine={{ stroke: 'var(--border)' }} width={52}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null
                    return (
                      <div className="chart-tooltip">
                        <div className="tt-date">{fmtDate(label as string)} {fmtTime(label as string)}</div>
                        {payload.map((p, i) => (
                          <div className="tt-row" key={i}>
                            <div className="tt-dot" style={{ background: p.color as string }} />
                            <span className="tt-label">{p.dataKey as string}</span>
                            <span className="tt-val">{p.value as number}</span>
                          </div>
                        ))}
                      </div>
                    )
                  }}
                />
                {chartSeries.map(s =>
                  chartType === 'line' ? (
                    <Line key={s.id} type="monotone" dataKey={s.id} stroke={s.color}
                      strokeWidth={2} dot={{ r: 3, fill: s.color, strokeWidth: 0 }}
                      activeDot={{ r: 5 }} connectNulls={false} />
                  ) : (
                    <Bar key={s.id} dataKey={s.id} fill={s.color}
                      radius={[2, 2, 0, 0]} maxBarSize={24} />
                  )
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
 
        {terms.filter(t => t.status === 'ok').map(term => (
          <div key={`${term.annotationId}::${term.source}`} className="parent-group">
            <button
              className={`mappings-toggle ${term.expanded ? 'open' : ''}`}
              onClick={() => setTerms(prev => prev.map(t =>
                t.annotationId === term.annotationId && t.source === term.source
                  ? { ...t, expanded: !t.expanded } : t
              ))}
              style={{ padding: '12px 16px', background: 'var(--surface2)',
                borderRadius: term.expanded ? '8px 8px 0 0' : 8 }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: term.color, flexShrink: 0 }} />
              <span className="toggle-icon">▶</span>
              <span className="toggle-label" style={{ fontWeight: 600, color: 'var(--text-h)' }}>{term.annotationId}</span>
              <span className={`tag ${SOURCE_TAG_CLS[term.source] ?? ''}`}>{term.source}</span>
              <span className="toggle-count">
                {term.summary.length} samples · max {Math.max(...term.summary.map(r => r.scaffold_count))} scaffolds
              </span>
            </button>
            {term.expanded && (
              <div className="expand-anim" style={{ padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
                <table className="mappings-table">
                  <thead><tr><th>Date</th><th>Time</th><th>Scaffolds</th><th>Genes</th></tr></thead>
                  <tbody>
                    {[...term.summary]
                      .filter(r => {
                        if (dateFrom && r.date < dateFrom) return false
                        if (dateTo   && r.date > dateTo)   return false
                        return true
                      })
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map((row, i) => (
                        <tr key={i}>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(row.date) || '—'}</td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtTime(row.date) || '—'}</td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{row.scaffold_count}</td>
                          <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{row.gene_count}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
 
        {terms.length === 0 && topStatus !== 'loading' && (
          <div className="state-box" style={{ padding: 32 }}>
            <div className="state-icon">🧬</div>
            <span>Search for an annotation term above to explore its scaffold distribution over time.</span>
          </div>
        )}
      </div>
    )
  }
function ExplorePage({
  state, setState, resetKey, dataDateRange, onSendToAnalyze,
}: {
  state: ExploreState
  setState: (updater: (prev: ExploreState) => ExploreState) => void
  resetKey: number
  dataDateRange: { min: string; max: string } | null
  onSendToAnalyze: (annotationId: string) => void
}) {
  const { copiedId, copy } = useCopyId()

  async function load() {
    setState(prev => ({ ...prev, status: 'loading' }))
    try {
      let url = `/api/annotations/top?source=${state.source}&limit=${state.limit}`
      if (state.dateFrom) url += `&date_from=${state.dateFrom}`
      if (state.dateTo)   url += `&date_to=${state.dateTo}`
      const r = await apiFetch<{ data: TopAnnotation[]; sample_count: number }>(url)
      setState(prev => ({ ...prev, rows: r.data ?? [], sampleCount: r.sample_count, status: 'ok' }))
    } catch {
      setState(prev => ({ ...prev, status: 'error' }))
    }
  }

  function toggleSort(col: ExploreSortCol) {
    setState(prev => ({
      ...prev,
      sortCol: col,
      sortDir: prev.sortCol === col ? (prev.sortDir === 'asc' ? 'desc' : 'asc') : 'desc',
    }))
  }

  const sorted = useMemo(() => {
    const q = state.topFilter.toLowerCase().trim()
    return [...state.rows]
      .filter(r => !q
        || r.annotation_id.toLowerCase().includes(q)
        || (r.name ?? '').toLowerCase().includes(q)
        || (r.parent ?? '').toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const av = a[state.sortCol] as number | string
        const bv = b[state.sortCol] as number | string
        if (typeof av === 'number' && typeof bv === 'number') {
          return state.sortDir === 'asc' ? av - bv : bv - av
        }
        return state.sortDir === 'asc'
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av))
      })
  }, [state.rows, state.sortCol, state.sortDir, state.topFilter])

  const SortTh = ({ col, label }: { col: ExploreSortCol; label: string }) => (
    <ExploreSortTh col={col} label={label} sortCol={state.sortCol} sortDir={state.sortDir} onSort={toggleSort} />
  )

  const maxMean = Math.max(...state.rows.map(r => r.mean_egc), 1)

  function toggleSection(s: ExploreSection) {
    setState(prev => ({ ...prev, openSection: prev.openSection === s ? null : s }))
  }

  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Explore Annotations</h1>
          <p className="subtitle">Dataset overview · top annotations by abundance · parent groupings</p>
        </div>
      </div>
      <div className="page-body">

        <div className="explore-section-cards">
          <button
            className={`explore-card ${state.openSection === 'overview' ? 'active' : ''}`}
            onClick={() => toggleSection('overview')}
          >
            <div className="explore-card-icon">📈</div>
            <div>
              <div className="explore-card-label">Dataset Overview</div>
              <div className="explore-card-desc">Summary statistics for any annotation type with date filtering</div>
            </div>
          </button>
          <button
            className={`explore-card ${state.openSection === 'top-egc' ? 'active' : ''}`}
            onClick={() => toggleSection('top-egc')}
          >
            <div className="explore-card-icon">📊</div>
            <div>
              <div className="explore-card-label">Top EGC Annotations</div>
              <div className="explore-card-desc">Highest mean abundance by source type, optional date filter</div>
            </div>
          </button>
          <button
            className={`explore-card ${state.openSection === 'by-parent' ? 'active' : ''}`}
            onClick={() => toggleSection('by-parent')}
          >
            <div className="explore-card-icon">🌿</div>
            <div>
              <div className="explore-card-label">Annotations by Parent</div>
              <div className="explore-card-desc">Browse grouped by parent category or pathway, with sum toggle</div>
            </div>
          </button>
          <button
            className={`explore-card ${state.openSection === 'lookup' ? 'active' : ''}`}
            onClick={() => toggleSection('lookup')}
          >
            <div className="explore-card-icon">🔎</div>
            <div>
              <div className="explore-card-label">Annotation Lookup</div>
              <div className="explore-card-desc">Full metadata and external database links for any annotation ID</div>
            </div>
            <button
            className={`explore-card ${state.openSection === 'scaffolds' ? 'active' : ''}`}
            onClick={() => toggleSection('scaffolds')}
          >
            <div className="explore-card-icon">🧬</div>
            <div>
              <div className="explore-card-label">Scaffold Information</div>
              <div className="explore-card-desc">Scaffold and gene counts over time, per annotation term</div>
            </div>
          </button>
          </button>
        </div>

        {state.openSection === 'overview' && (
          <div className="explore-panel expand-anim">
            <DatasetOverviewPanel resetKey={resetKey} dataDateRange={dataDateRange} />
          </div>
        )}

        {state.openSection === 'top-egc' && (
          <div className="explore-panel expand-anim">
            <div style={{ padding: '20px 24px 0' }}>
              <div style={{ marginBottom: 12 }}><h2>Top EGC Annotations</h2></div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
                <select
                  className="field" style={{ width: 140 }}
                  value={state.source}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setState(prev => ({ ...prev, source: e.target.value }))}
                >
                  {['kegg', 'cog', 'enzyme', 'taxonomy'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label style={{ fontSize: 13, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>Top N:</label>
                  <input
                    className="field" type="number" min={5} max={200} value={state.limit}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setState(prev => ({ ...prev, limit: Math.max(5, Math.min(200, Number(e.target.value))) }))}
                    style={{ width: 80 }}
                  />
                </div>
                <DateRangePicker
                  from={state.dateFrom} to={state.dateTo}
                  onFrom={v => setState(prev => ({ ...prev, dateFrom: v }))}
                  onTo={v => setState(prev => ({ ...prev, dateTo: v }))}
                  onClear={() => setState(prev => ({ ...prev, dateFrom: '', dateTo: '' }))}
                  minDate={dataDateRange?.min}
                  maxDate={dataDateRange?.max}
                />
                <button className="btn primary" onClick={load} disabled={state.status === 'loading'}>
                  {state.status === 'loading' ? 'Loading…' : 'Load'}
                </button>
                {state.status === 'ok' && state.rows.length > 0 && (
                  <button className="btn sm"
                    onClick={() => downloadCsv(sorted.map(r => ({ ...r, source: state.source })), `top_${state.source}_annotations.csv`)}>
                    ↓ CSV
                  </button>
                )}
              </div>
              {state.status === 'ok' && state.sampleCount !== null && (
                <div style={{ marginBottom: 8, fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
                  Based on {state.sampleCount} sample{state.sampleCount !== 1 ? 's' : ''}
                  {state.dateFrom || state.dateTo ? ` · ${state.dateFrom || '…'} → ${state.dateTo || '…'}` : ' (all dates)'}
                </div>
              )}

              {state.status === 'ok' && state.rows.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <input
                    className="field"
                    placeholder="Filter by ID, name, or parent group…"
                    value={state.topFilter}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setState(prev => ({ ...prev, topFilter: e.target.value }))}
                    style={{ flex: 1, maxWidth: 360 }}
                  />
                  {state.topFilter && (
                    <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                      {sorted.length} of {state.rows.length}
                    </span>
                  )}
                  {state.topFilter && (
                    <button className="btn ghost sm" onClick={() => setState(prev => ({ ...prev, topFilter: '' }))}>✕</button>
                  )}
                </div>
              )}
            </div>

            {state.status === 'idle' && (
              <div className="state-box" style={{ padding: 32 }}>
                <div className="state-icon">📊</div>
                <span>Choose a source type and click Load to view top annotations.</span>
              </div>
            )}
            {state.status === 'loading' && (
              <div className="state-box" style={{ padding: 32 }}><span>Computing top annotations…</span></div>
            )}
            {state.status === 'error' && (
              <div className="state-box error" style={{ padding: 32 }}>
                <div className="state-icon">⚠</div>
                <span>Failed to load — is the API running?</span>
              </div>
            )}

            {state.status === 'ok' && sorted.length > 0 && (
              <div style={{ padding: '0 0 20px' }}>
                <table className="ann-table" style={{ borderRadius: 0, border: 'none', borderTop: '1px solid var(--border)' }}>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>#</th>
                      <th>Annotation ID</th>
                      <th>Name</th>
                      <th>Group</th>
                      <SortTh col="mean_egc" label="Mean EGC" />
                      <SortTh col="sample_count" label="Samples" />
                      <th title="Trend: last-quarter mean vs first-quarter mean">Trend</th>
                      <th>Scaffolds</th>
                      <th>Relative</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((row, i) => (
                      <tr key={row.annotation_id}>
                        <td style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                          {i + 1}
                        </td>
                        <td className="id-cell">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <CopyBtn id={row.annotation_id} copiedId={copiedId} onCopy={copy} />
                            {row.annotation_id}
                          </div>
                        </td>
                        <td className="name-cell">{row.name ?? '—'}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={row.parent ? expandParentLabel(row.parent, state.source) : undefined}>
                          {row.parent ? expandParentLabel(row.parent, state.source) : '—'}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{row.mean_egc.toExponential(2)}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{row.sample_count}</td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 13, textAlign: 'center' }}>
                          <span style={{ color: 'var(--text-dim)' }} title="Expand in Analyze to see trend">—</span>
                        </td>
                        <td>
                          <ScaffoldBtn annotationId={row.annotation_id} source={state.source} />
                        </td>
                        <td style={{ minWidth: 80 }}>
                          <div style={{
                            height: 6, borderRadius: 3,
                            background: `linear-gradient(90deg, var(--teal) ${(row.mean_egc / maxMean) * 100}%, var(--surface2) 0%)`,
                            minWidth: 4,
                          }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {state.openSection === 'by-parent' && (
          <div className="explore-panel expand-anim">
            <div style={{ padding: '20px 24px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
              <h2>Annotations by Parent</h2>
              <select
                className="field" style={{ width: 140 }}
                value={state.parentSource}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  setState(prev => ({ ...prev, parentSource: e.target.value }))}
              >
                {['kegg', 'cog', 'enzyme', 'taxonomy'].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div style={{ padding: '0 24px 24px' }}>
              <AnnotationsByParentPanel source={state.parentSource} />
            </div>
          </div>
        )}

        {state.openSection === 'lookup' && (
          <div className="explore-panel expand-anim">
            <div style={{ padding: '20px 24px 24px' }}>
              <div style={{ marginBottom: 4 }}><h2>Annotation Lookup</h2></div>
              <p style={{ font: '12px var(--sans)', color: 'var(--text-dim)', marginBottom: 16 }}>
                Search by ID, name, or keyword — exact IDs return one result; general terms return a ranked list.
              </p>

              {/* Search bar */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
                <select
                  className="field" style={{ width: 130 }}
                  value={state.lookupSource}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setState(prev => ({
                      ...prev, lookupSource: e.target.value,
                      lookupResults: [], lookupSelected: null, lookupTotal: 0, lookupStatus: 'idle',
                    }))}
                >
                  {(['kegg', 'cog', 'enzyme', 'taxonomy'] as const).map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <input
                  className="field"
                  placeholder="ID (K02014) or keyword (iron transport, siderophore…)"
                  value={state.lookupId}
                  style={{ flex: 1, minWidth: 220, maxWidth: 420 }}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setState(prev => ({
                      ...prev, lookupId: e.target.value,
                      lookupResults: [], lookupSelected: null, lookupTotal: 0, lookupStatus: 'idle',
                    }))}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') (e.currentTarget.nextElementSibling as HTMLButtonElement)?.click()
                  }}
                />
                <button
                  className="btn primary"
                  disabled={!state.lookupId.trim() || state.lookupStatus === 'loading'}
                  onClick={async () => {
                    const term = state.lookupId.trim()
                    if (!term) return
                    setState(prev => ({ ...prev, lookupStatus: 'loading', lookupSelected: null }))
                    try {
                      const src = state.lookupSource
                      // Heuristic: if the term looks like an exact ID, try annotation_id first
                      // for a fast exact match. Always also run q= for general results.
                      const isExactId = /^[A-Za-z0-9.:_-]+$/.test(term) && !term.includes(' ')
                      const url = isExactId
                        ? `/api/search/annotations?q=${encodeURIComponent(term)}&sources=${src}&page_size=25`
                        : `/api/search/annotations?q=${encodeURIComponent(term)}&sources=${src}&page_size=25`
                      const r = await apiFetch<{ data: TopAnnotation[]; total: number }>(url)
                      const results = r.data ?? []
                      setState(prev => ({
                        ...prev,
                        lookupResults:  results,
                        lookupSelected: results.length === 1 ? results[0] : null,
                        lookupTotal:    r.total ?? results.length,
                        lookupStatus:   results.length > 0 ? 'ok' : 'error',
                      }))
                    } catch {
                      setState(prev => ({ ...prev, lookupStatus: 'error' }))
                    }
                  }}
                >
                  {state.lookupStatus === 'loading' ? 'Searching…' : 'Search'}
                </button>
              </div>

              {/* States */}
              {state.lookupStatus === 'idle' && (
                <div className="state-box" style={{ padding: 28 }}>
                  <div className="state-icon">🔎</div>
                  <span>Enter an ID or keyword and press Search or Enter.</span>
                </div>
              )}

              {state.lookupStatus === 'error' && (
                <div className="state-box error" style={{ padding: 20 }}>
                  <div className="state-icon">∅</div>
                  <span>No results for <strong>{state.lookupId}</strong> in {state.lookupSource}.</span>
                </div>
              )}

              {state.lookupStatus === 'ok' && state.lookupResults.length > 0 && (
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>

                  {/* Result list — always visible */}
                  <div style={{ flex: '0 0 300px', minWidth: 0 }}>
                    <div style={{
                      font: '10px var(--mono)', color: 'var(--text-dim)', letterSpacing: '.06em',
                      textTransform: 'uppercase', padding: '0 2px 8px',
                    }}>
                      {state.lookupTotal} result{state.lookupTotal !== 1 ? 's' : ''}
                      {state.lookupTotal > state.lookupResults.length &&
                        ` · showing ${state.lookupResults.length}`}
                      {' · click to view details'}
                    </div>
                    <div style={{
                      border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden',
                      maxHeight: 480, overflowY: 'auto',
                    }}>
                      {state.lookupResults.map(row => {
                        const isSelected = state.lookupSelected?.annotation_id === row.annotation_id
                        return (
                          <div
                            key={row.annotation_id}
                            onClick={() => setState(prev => ({ ...prev, lookupSelected: row }))}
                            style={{
                              padding: '9px 12px',
                              borderBottom: '1px solid var(--border)',
                              cursor: 'pointer',
                              background: isSelected ? 'rgba(61,217,184,.08)' : 'var(--surface)',
                              borderLeft: isSelected ? '3px solid var(--teal)' : '3px solid transparent',
                              transition: 'background .1s',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                              <span style={{ font: '600 12px var(--mono)', color: 'var(--teal)' }}>
                                {row.annotation_id}
                              </span>
                              <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)' }}>
                                {row.mean_egc.toExponential(2)}
                              </span>
                            </div>
                            {row.name && (
                              <div style={{
                                font: '12px var(--sans)', color: 'var(--text-dim)',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                              }}>
                                {row.name}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Detail card — shown when a result is selected */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {state.lookupSelected ? (() => {
                      const r      = state.lookupSelected
                      const links  = externalLinks(r.annotation_id, state.lookupSource)
                      const parent = r.parent ? expandParentLabel(r.parent, state.lookupSource) : null
                      return (
                        <div className="lookup-result">
                          <div className="lookup-header">
                            <span className={`tag ${SOURCE_TAG_CLS[state.lookupSource] ?? ''}`}>{state.lookupSource}</span>
                            <span className="lookup-id">{r.annotation_id}</span>
                            {r.name && <span className="lookup-name">{r.name}</span>}
                          </div>
                          <div className="lookup-meta-grid">
                            {parent && (
                              <div className="lookup-meta-row">
                                <span className="lookup-meta-label">Parent</span>
                                <span className="lookup-meta-value">{parent}</span>
                              </div>
                            )}
                            <div className="lookup-meta-row">
                              <span className="lookup-meta-label">Mean EGC</span>
                              <span className="lookup-meta-value mono">{r.mean_egc.toExponential(3)}</span>
                            </div>
                            <div className="lookup-meta-row">
                              <span className="lookup-meta-label">Max EGC</span>
                              <span className="lookup-meta-value mono">{r.max_egc.toExponential(3)}</span>
                            </div>
                            <div className="lookup-meta-row">
                              <span className="lookup-meta-label">Samples</span>
                              <span className="lookup-meta-value mono">{r.sample_count} / 128</span>
                            </div>
                          </div>
                          {links && (
                            <div className="lookup-links-section">
                              <div className="lookup-links-label">External Databases</div>
                              <div className="lookup-links">{links}</div>
                            </div>
                          )}
                          <div style={{
                            padding: '12px 18px',
                            borderTop: '1px solid var(--border)',
                            background: 'var(--surface2)',
                          }}>
                            <button
                              className="btn sm primary"
                              onClick={() => onSendToAnalyze(r.annotation_id)}
                              title={`Search for ${r.annotation_id} in Analyze and view its EGC time series`}
                            >
                              → View Timeseries in Analyze
                            </button>
                          </div>
                        </div>
                      )
                    })() : (
                      <div className="state-box" style={{ padding: 28, border: '1px dashed var(--border)', borderRadius: 8 }}>
                        <div className="state-icon">←</div>
                        <span style={{ fontSize: 13 }}>Select a result to see full details and database links.</span>
                      </div>
                    )}
                  </div>

                </div>
              )}
            </div>
          </div>
        )}
        {state.openSection === 'scaffolds' && (
          <div className="explore-panel expand-anim">
            <ScaffoldExplorePanel
              initialTerms={state.scaffoldInitialTerms}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ── Compare Page ───────────────────────────────────────────────────────────

function ComparePage({
  state, setState, initialAnnotations, onConsumed,
}: {
  state: CompareState
  setState: (updater: (prev: CompareState) => CompareState) => void
  initialAnnotations: SharedAnnotation[]
  onConsumed: () => void
}) {
  const { copiedId, copy } = useCopyId()

  // When annotations arrive from Analyze, auto-load them
  useEffect(() => {
    if (!initialAnnotations.length) return
    onConsumed()
    resetSourceCounters()
    const toLoad  = initialAnnotations.slice(0, 4)
    const dropped = initialAnnotations.length - toLoad.length
    if (dropped > 0) {
      // Non-blocking notification — don't use alert() which blocks the UI
      console.warn(`Compare page: ${dropped} annotation(s) dropped — only 4 slots available.`)
    }
    const colors = toLoad.map(ann => nextColorForSource(ann.source))
    setState(prev => ({
      ...prev,
      entries: toLoad.map((ann, i) => ({
        annotationId: ann.annotationId, source: ann.source,
        name: ann.name, data: [], status: 'loading' as ApiStatus, color: colors[i],
      })),
    }))
    Promise.all(toLoad.map((ann, i) =>
      apiFetch<{ data: AnnotationItem[] }>(
        `/api/series/annotations?source=${ann.source}&annotation_id=${encodeURIComponent(ann.annotationId)}&page_size=5000`
      ).then(json => ({ ann, i, data: json.data ?? [] }))
       .catch(() => ({ ann, i, data: [] as AnnotationItem[] }))
    )).then(results => {
      setState(prev => ({
        ...prev,
        entries: results.map(({ ann, i, data }) => ({
          annotationId: ann.annotationId, source: ann.source,
          name: ann.name, data,
          status: (data.length > 0 ? 'ok' : 'error') as ApiStatus,
          color: colors[i],
        })),
      }))
    })
  }, [initialAnnotations])

  // ── Bulk-add search results ────────────────────────────────────────────
  // Users can now select multiple search results at once before adding them.
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set())

  async function searchForAdd() {
    const q = state.query.trim()
    if (!q) return
    setState(prev => ({ ...prev, searchStatus: 'loading' }))
    setBulkSelected(new Set())
    try {
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/search/annotations?q=${encodeURIComponent(q)}&sources=${state.querySource}&page_size=500`
      )
      const seen = new Set<string>()
      const unique = (json.data ?? []).filter(r => {
        if (seen.has(r.annotation_id)) return false
        seen.add(r.annotation_id); return true
      })
      setState(prev => ({ ...prev, searchResults: unique, searchStatus: 'ok' }))
    } catch {
      setState(prev => ({ ...prev, searchStatus: 'error' }))
    }
  }

  function toggleBulkSelect(annotationId: string) {
    setBulkSelected(prev => {
      const next = new Set(prev)
      if (next.has(annotationId)) next.delete(annotationId)
      else if (state.entries.length + next.size < 4) next.add(annotationId)
      return next
    })
  }

  async function addSelectedAnnotations() {
    const toAdd = state.searchResults.filter(r => bulkSelected.has(r.annotation_id))
    if (!toAdd.length) return

    const colors = toAdd.map(ann => nextColorForSource(ann.source))
    const newEntries: CompareEntry[] = toAdd.map((ann, i) => ({
      annotationId: ann.annotation_id, source: ann.source,
      name: ann.name, data: [], status: 'loading', color: colors[i],
    }))

    setState(prev => ({
      ...prev,
      entries: [...prev.entries, ...newEntries].slice(0, 4),
      searchResults: [],
      query: '',
    }))
    setBulkSelected(new Set())

    await Promise.all(toAdd.map(async (ann, i) => {
      try {
        const json = await apiFetch<{ data: AnnotationItem[] }>(
          `/api/series/annotations?source=${ann.source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=5000`
        )
        setState(prev => ({
          ...prev,
          entries: prev.entries.map(e =>
            e.annotationId === ann.annotation_id && e.source === ann.source
              ? { ...e, data: json.data ?? [], status: 'ok' }
              : e
          ),
        }))
      } catch {
        setState(prev => ({
          ...prev,
          entries: prev.entries.map(e =>
            e.annotationId === ann.annotation_id && e.source === ann.source
              ? { ...e, status: 'error' }
              : e
          ),
        }))
      }
    }))
  }

  // Legacy single-add (clicking a result directly)
  async function addAnnotation(ann: AnnotationItem) {
    if (state.entries.length >= 4) return
    if (state.entries.some(e => e.annotationId === ann.annotation_id && e.source === ann.source)) return
    const color = nextColorForSource(ann.source)
    setState(prev => ({
      ...prev,
      entries: [...prev.entries, {
        annotationId: ann.annotation_id, source: ann.source,
        name: ann.name, data: [], status: 'loading', color,
      }],
      searchResults: [],
      query: '',
    }))
    try {
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/series/annotations?source=${ann.source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=5000`
      )
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e =>
          e.annotationId === ann.annotation_id && e.source === ann.source
            ? { ...e, data: json.data ?? [], status: 'ok' } : e
        ),
      }))
    } catch {
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e =>
          e.annotationId === ann.annotation_id && e.source === ann.source
            ? { ...e, status: 'error' } : e
        ),
      }))
    }
  }

  const readyEntries   = state.entries.filter(e => e.status === 'ok')
  const slotsRemaining = 4 - state.entries.length

  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Compare Annotations</h1>
          <p className="subtitle">
            Overlay up to 4 annotations · L1 normalize · LOWESS smooth · 4 max keeps the chart readable
          </p>
        </div>
      </div>
      <div className="page-body">
        <div>
          <div style={{ marginBottom: 8 }}><h2>Add Annotations</h2></div>
          <div className="search-bar" style={{ marginBottom: 10 }}>
            <select
              className="field" style={{ width: 130, flex: 'none' }}
              value={state.querySource}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                setState(prev => ({ ...prev, querySource: e.target.value }))}
            >
              {['kegg', 'cog', 'enzyme', 'taxonomy'].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input
              className="field"
              placeholder="Search annotation ID or name…"
              value={state.query}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setState(prev => ({ ...prev, query: e.target.value }))}
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
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 8, overflow: 'hidden',
              }}>
                {/* Header with select-all + bulk add */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '9px 16px',
                  background: 'var(--surface3)',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', font: '400 12px var(--mono)', color: 'var(--text-dim)' }}>
                    <input
                      type="checkbox"
                      checked={bulkSelected.size > 0 &&
                        state.searchResults.slice(0, slotsRemaining).every(r => bulkSelected.has(r.annotation_id))}
                      onChange={() => {
                        const allSlice = state.searchResults.slice(0, slotsRemaining).map(r => r.annotation_id)
                        const allSelected = allSlice.every(id => bulkSelected.has(id))
                        setBulkSelected(new Set(allSelected ? [] : allSlice))
                      }}
                    />
                    Select all visible
                  </label>
                  <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                    {state.searchResults.length} results · {slotsRemaining} slot{slotsRemaining !== 1 ? 's' : ''} available
                  </span>
                  {bulkSelected.size > 0 && (
                    <button
                      className="btn sm primary"
                      style={{ marginLeft: 'auto' }}
                      onClick={addSelectedAnnotations}
                    >
                      + Add {bulkSelected.size} selected
                    </button>
                  )}
                  {bulkSelected.size === 0 && (
                    <span style={{ marginLeft: 'auto', font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                      Check boxes below, or click a row to add one
                    </span>
                  )}
                </div>

                {state.searchResults.slice(0, 12).map((r, i) => {
                  const alreadyAdded = state.entries.some(e => e.annotationId === r.annotation_id && e.source === r.source)
                  const isChecked    = bulkSelected.has(r.annotation_id)
                  const canAdd       = !alreadyAdded && slotsRemaining > 0

                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 16px',
                        cursor: canAdd ? 'pointer' : 'default',
                        opacity: alreadyAdded ? 0.45 : 1,
                        borderBottom: i < Math.min(12, state.searchResults.length) - 1
                          ? '1px solid var(--border)' : 'none',
                        background: isChecked ? 'var(--teal-dim)' : 'transparent',
                        transition: 'background .12s',
                      }}
                      onClick={() => canAdd && !bulkSelected.size ? addAnnotation(r) : undefined}
                      onMouseEnter={e => { if (!isChecked) e.currentTarget.style.background = 'var(--surface2)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = isChecked ? 'var(--teal-dim)' : '' }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!canAdd}
                        onChange={() => toggleBulkSelect(r.annotation_id)}
                        onClick={e => e.stopPropagation()}
                        style={{ flexShrink: 0 }}
                      />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--teal)', flexShrink: 0 }}>
                        {r.annotation_id}
                      </span>
                      <span style={{ fontSize: 14, color: 'var(--text-h)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.name ?? '—'}
                      </span>
                      <span className={`tag ${SOURCE_TAG_CLS[r.source] ?? ''}`}>{r.source}</span>
                      {alreadyAdded
                        ? <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>added</span>
                        : <span style={{ color: 'var(--teal)', fontSize: 18 }}>+</span>
                      }
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {state.searchStatus === 'error' && (
            <div className="state-box error" style={{ padding: '12px' }}>
              <span>Search failed.</span>
            </div>
          )}
        </div>

        {state.entries.length > 0 && (
          <div>
            <div style={{ marginBottom: 10 }}><h2>Selected Annotations</h2></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {state.entries.map(e => (
                <div className="compare-chip" key={`${e.annotationId}::${e.source}`}>
                  <div className="chip-color" style={{ background: e.color }} />
                  <CopyBtn id={e.annotationId} copiedId={copiedId} onCopy={copy} />
                  <span>{e.annotationId}</span>
                  <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{e.source}</span>
                  {e.status === 'loading' && (
                    <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>…</span>
                  )}
                  <button
                    className="chip-remove"
                    onClick={() => setState(prev => {
                      const next = prev.entries.filter(
                        x => !(x.annotationId === e.annotationId && x.source === e.source)
                      )
                      if (next.length === 0) resetSourceCounters()
                      return { ...prev, entries: next }
                    })}
                  >
                    ×
                  </button>
                </div>
              ))}
              {state.entries.length < 4 && (
                <span style={{
                  fontSize: 13, fontFamily: 'var(--mono)',
                  color: 'var(--text-dim)', alignSelf: 'center',
                }}>
                  + add up to {4 - state.entries.length} more
                </span>
              )}
            </div>

            {readyEntries.length > 0 && (
              <>
                <div style={{
                  display: 'flex', gap: 10, alignItems: 'center',
                  marginBottom: 12, flexWrap: 'wrap',
                }}>
                  <DateRangePicker
                    from={state.dateFrom} to={state.dateTo}
                    onFrom={v => setState(prev => ({ ...prev, dateFrom: v }))}
                    onTo={v => setState(prev => ({ ...prev, dateTo: v }))}
                    onClear={() => setState(prev => ({ ...prev, dateFrom: '', dateTo: '' }))}
                  />
                  <button
                    className="btn sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => {
                      const rowsOut: Record<string, unknown>[] = []
                      for (const e of readyEntries) {
                        for (const d of e.data) {
                          const iso = isoDate(d.timepoint?.datetime ?? '')
                          if (state.dateFrom && iso < state.dateFrom) continue
                          if (state.dateTo   && iso > state.dateTo)   continue
                          rowsOut.push({
                            annotation_id: e.annotationId, source: e.source,
                            sample: d.sample, date: d.timepoint?.datetime ?? '',
                            egc: extractEgc(d.value),
                          })
                        }
                      }
                      downloadCsv(rowsOut, 'compare_egc.csv')
                    }}
                  >
                    ↓ CSV
                  </button>
                </div>
                <ChartErrorBoundary label="Compare overlay">
                  <MultiEgcChart
                    series={readyEntries.map(e => ({
                      annotationId: e.annotationId,
                      name:         e.name,
                      data:         e.data,
                      color:        e.color,
                    }))}
                    dateFrom={state.dateFrom} dateTo={state.dateTo}
                  />
                </ChartErrorBoundary>
              </>
            )}

            {readyEntries.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <hr className="divider" />
                <button
                  className={`mappings-toggle ${state.showMappings ? 'open' : ''}`}
                  onClick={() => setState(prev => ({ ...prev, showMappings: !prev.showMappings }))}
                >
                  <span className="toggle-icon">▶</span>
                  <span className="toggle-label">View Mappings for All Selected Annotations</span>
                </button>
                {state.showMappings && readyEntries.map(e => (
                  <div key={`${e.annotationId}::${e.source}`} style={{ marginBottom: 16 }}>
                    <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: e.color }} />
                      <span style={{ fontSize: 13, fontFamily: 'var(--mono)', color: 'var(--text-h)' }}>
                        {e.annotationId}
                      </span>
                      <span className={`tag ${SOURCE_TAG_CLS[e.source] ?? ''}`}>{e.source}</span>
                    </div>
                    <MappingsPanel annotationId={e.annotationId} source={e.source} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {state.entries.length === 0 && (
          <div className="state-box">
            <div className="state-icon">📊</div>
            <span>Search for annotations above. Select one or more checkboxes, then click &quot;Add N selected&quot; — or click any row directly to add it.</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── About Page ─────────────────────────────────────────────────────────────

function AboutPage() {
  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>About HAB Portal</h1>
          <p className="subtitle">Annotation types, usage guide, and API reference</p>
        </div>
      </div>
      <div className="page-body">
        <div>
          <div style={{ marginBottom: 12 }}><h2>Annotation Types</h2></div>
          <div className="about-grid">
            {[
              {
                label: 'Functional', title: 'KEGG Orthology (KO)',
                desc: 'KEGG Orthology terms represent functional orthologs across species and link genes to metabolic pathways, biological processes, and molecular functions.',
                ex: 'K02014 · K00001 · K16950',
              },
              {
                label: 'Functional', title: 'COG',
                desc: 'Clusters of Orthologous Groups — a classification system for proteins that assigns genes to functional categories conserved across bacteria, archaea, and eukaryotes.',
                ex: 'COG0001 · COG1234',
              },
              {
                label: 'Biochemical', title: 'Enzyme Commission (EC)',
                desc: 'EC numbers classify enzymes by the chemical reactions they catalyze. Hierarchical: class → subclass → sub-subclass → serial number.',
                ex: 'EC:1.1.1.1 · EC:4.2.1.17',
              },
              {
                label: 'Biological', title: 'Taxonomy',
                desc: 'Taxonomic classifications assign genes and contigs to organisms across the tree of life, from phylum down to species level.',
                ex: 'Tenacibaculum maritimum',
              },
            ].map(c => (
              <div className="about-card" key={c.title}>
                <div className="card-type-label">{c.label}</div>
                <h3>{c.title}</h3>
                <p>{c.desc}</p>
                <div className="card-id-example">{c.ex}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div style={{ marginBottom: 12 }}><h2>How Values Are Calculated</h2></div>
          <div className="about-card" style={{ lineHeight: 1.9 }}>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>EGC — Estimated Gene Copies</strong>
              <br />
              <code style={{ fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface2)', padding: '2px 6px', borderRadius: 4 }}>
                EGC(annotation, sample) = Σ scaffold ( gene_count × coverage )
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                For each scaffold contributing genes to an annotation, the gene count is multiplied by the scaffold's sequencing coverage (read depth). EGC is the sum across all contributing scaffolds. Higher EGC indicates more copies of that functional gene in the community.
              </span>
            </p>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>norm_egc — Depth-Normalised EGC (L1 mode)</strong>
              <br />
              <code style={{ fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface2)', padding: '2px 6px', borderRadius: 4 }}>
                norm_egc = EGC(annotation, sample) / total_coverage(sample)
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Divides raw EGC by the total sequencing depth of the sample. Removes sequencing effort bias — samples sequenced more deeply are directly comparable to shallower ones. Use L1 mode when comparing relative abundance across samples.
              </span>
            </p>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>Z-score Normalisation</strong>
              <br />
              <code style={{ fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface2)', padding: '2px 6px', borderRadius: 4 }}>
                Z = ( EGC − μ ) / s &nbsp;&nbsp; where s = sample std dev (÷ n−1, Bessel-corrected)
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Centres each series at zero and scales by its standard deviation. A value of +2 means 2 std deviations above that annotation's mean across the bloom. Best for comparing trend shapes across annotations with very different EGC magnitudes.
              </span>
            </p>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>LOWESS Smoothing</strong>
              <br />
              <code style={{ fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface2)', padding: '2px 6px', borderRadius: 4 }}>
                ŷᵢ = local weighted linear regression · span = ⌈bandwidth × n⌉ neighbors · tricube kernel w = (1 − |u|³)³
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Locally Weighted Scatterplot Smoothing. At each timepoint, a weighted linear model is fit using the nearest fraction (bandwidth) of data points. Closer points receive higher weight. Lower bandwidth = tighter fit to local fluctuations; higher = smoother global trend. Range: 0.05 (tight) → 0.75 (near-linear).
              </span>
            </p>

            <p style={{ marginBottom: 16 }}>
              <strong style={{ color: 'var(--teal)' }}>Spearman CLR Correlation</strong>
              <br />
              <code style={{ fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface2)', padding: '2px 6px', borderRadius: 4 }}>
                rₛ = Spearman rank correlation on CLR-transformed EGC · p-value via circular-shift permutation (n=1000, seed=42)
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                EGC values are first transformed using Centred Log Ratio (CLR) to handle the compositional nature of metagenomic data. Lag is the time offset (in 4-hour steps) that maximises |r|. The p-value is the fraction of 1000 circular-shifted permutations that exceed the observed |r|.
              </span>
            </p>

            <p>
              <strong style={{ color: 'var(--teal)' }}>Descriptive Statistics</strong>
              <br />
              <code style={{ fontFamily: 'var(--mono)', fontSize: 12, background: 'var(--surface2)', padding: '2px 6px', borderRadius: 4 }}>
                Median / Q1 / Q3: Type 7 linear interpolation (R default, numpy default) · Std Dev s: sample (÷ n−1) · CV = s / mean
              </code>
              <br />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Quartiles use linear interpolation at index h = (n−1) × p — matches R's quantile() and numpy.percentile(). Std dev is Bessel-corrected (÷ n−1) and labelled "s" to distinguish from population σ.
              </span>
            </p>

          </div>
        </div>
        <div>
          <div style={{ marginBottom: 12 }}><h2>How to Use</h2></div>
          <div className="about-card" style={{ lineHeight: 1.9 }}>
            <p>
              <strong style={{ color: 'var(--teal)' }}>Analyze (two-column workspace):</strong> Enter one or more search terms — each gets its own tab in the left column. Check rows to select annotations, then click <strong>+ Add N</strong> to add individual time-series chart cards to the right column, or <strong>∑ Group</strong> to sum their EGC into one chart. The <strong>Compare drawer</strong> (bottom of right column) overlays multiple series for direct visual comparison — drag the top edge to resize it.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--violet)' }}>Compare (dedicated overlay page):</strong> Search and bulk-select up to 4 annotations to overlay on a shared chart. Selections persist when switching pages. Use <strong>Z-score normalize</strong> when series have very different EGC magnitudes.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--amber)' }}>Explore:</strong> Two views — <em>Top EGC Annotations</em> (highest-abundance, filterable by date range) and <em>Annotations by Parent</em> (grouped by pathway/category with collapsible time series). Click Load to fetch results.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>Normalize modes:</strong> <em>Off</em> — raw EGC. <em>L1</em> — depth-normalised EGC (norm_egc = egc / total sample sequencing depth), directly comparable across samples. <em>Z-score</em> — std deviations from mean, best for comparing trends across different scales.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>LOWESS Smooth:</strong> Locally weighted regression — fits a weighted linear model at each point using nearby neighbors. Lower bandwidth = tighter fit; higher = smoother trend.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>EGC</strong> (Estimated Gene Copies per liter) — normalized for sequencing depth across all 128 samples collected at 4-hour intervals.
            </p>
            <p style={{ marginTop: 12 }}>
              <strong style={{ color: 'var(--text-dim)' }}>Reset:</strong> Clears all page state across Analyze, Compare, and Explore simultaneously.
            </p>
          </div>
        </div>

        <div>
          <div style={{ marginBottom: 12 }}><h2>API Reference</h2></div>
          <div className="api-ref">
            {[
              ['/api/timepoints', 'List all 128 sample timepoints with dates'],
              ['/api/samples', 'List all samples with timepoint metadata'],
              ['/api/samples/{id}/mappings', 'Gene mappings for one sample'],
              ['/api/samples/{id}/kegg', 'KEGG annotations for one sample'],
              ['/api/samples/{id}/cog', 'COG annotations for one sample'],
              ['/api/samples/{id}/enzyme', 'Enzyme annotations for one sample'],
              ['/api/samples/{id}/taxonomy', 'Taxonomy annotations for one sample'],
              ['/api/search/annotations?q=…&sources=kegg', 'Cross-sample annotation search (inverted index)'],
              ['/api/series/annotations?source=…&annotation_id=…', 'EGC time series for one annotation'],
              ['/api/mappings/search?annotation_id=…&source=…', 'Filtered cross-sample mapping rows'],
              ['/api/annotations/top?source=…&limit=25', 'Top N annotations by mean EGC, optional date_from/date_to'],
              ['/api/annotations/correlate?source=kegg&annotation_id=K02014&mode=cross', 'Spearman+lag correlation, cross-source or within-source parent-filtered. Returns spearman_r, lag_hours, p_value, n_pairs. Add &skip_pvalue=true for instant exploratory results.'],
            ].map(([path, desc], i) => (
              <div className="api-ref-row" key={i}>
                <span className="api-method">GET</span>
                <div>
                  <div className="api-ref-path">{path}</div>
                  <div className="api-ref-desc">{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Nav ────────────────────────────────────────────────────────────────────

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  {
    id: 'analyze', label: 'Analyze',
    icon: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M12.5 12.5L16 16"/></svg>`,
  },
  {
    id: 'compare', label: 'Compare',
    icon: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2,14 6,8 10,11 14,5"/><polyline points="9,5 14,5 14,10"/></svg>`,
  },
  {
    id: 'explore', label: 'Explore',
    icon: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="10" width="3" height="6" rx="1"/><rect x="7.5" y="6" width="3" height="10" rx="1"/><rect x="13" y="2" width="3" height="14" rx="1"/></svg>`,
  },
  {
    id: 'about', label: 'About & API',
    icon: `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="9" r="7"/><line x1="9" y1="8" x2="9" y2="13"/><circle cx="9" cy="5.5" r=".75" fill="currentColor" stroke="none"/></svg>`,
  },
]

// ── App — all page states live here so navigation never destroys them ──────

export default function App() {
  const [page, setPage]           = useState<Page>('analyze')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [theme, setTheme]         = useState<Theme>('light')
  const [apiOnline, setApiOnline] = useState<boolean | null>(null)
  const [resetKey, setResetKey]   = useState(0)
  const [uiMode, setUiMode] = useState<UiMode>('basic')
  const [pendingCompareAnns, setPendingCompareAnns] = useState<SharedAnnotation[]>([])
  const [indexReady, setIndexReady] = useState(false)
  const [dataDateRange, setDataDateRange] = useState<{ min: string; max: string } | null>(null)

  // ── Per-page persistent state ──────────────────────────────────────────
  const [analyzeState, setAnalyzeStateRaw] = useState<AnalyzeState>(makeDefaultAnalyzeState)
  const [exploreState, setExploreStateRaw] = useState<ExploreState>(makeDefaultExploreState)
  const [compareState, setCompareStateRaw] = useState<CompareState>(makeDefaultCompareState)

  // Wrapper updaters accept (prev => next) functions
  const setAnalyzeState = useCallback(
    (updater: (prev: AnalyzeState) => AnalyzeState) =>
      setAnalyzeStateRaw(updater),
    []
  )
  const setExploreState = useCallback(
    (updater: (prev: ExploreState) => ExploreState) =>
      setExploreStateRaw(updater),
    []
  )
  const setCompareState = useCallback(
    (updater: (prev: CompareState) => CompareState) =>
      setCompareStateRaw(updater),
    []
  )

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    apiFetch<{ total: number }>('/api/timepoints?page_size=1')
      .then(() => setApiOnline(true))
      .catch(() => setApiOnline(false))
  }, [])

  useEffect(() => {
    if (indexReady) return
    const check = () => {
      apiFetch<{ index_ready: boolean; date_min?: string; date_max?: string }>('/api/status')
        .then(r => {
          if (r.index_ready) setIndexReady(true)
          if (r.date_min && r.date_max && !dataDateRange) {
            setDataDateRange({ min: r.date_min, max: r.date_max })
          }
        })
        .catch(() => {})
    }
    check()
    const interval = setInterval(check, 2000)
    return () => clearInterval(interval)
  }, [indexReady])

  // Reset clears ALL page states simultaneously
  function handleReset() {
    setResetKey(k => k + 1)
    setAnalyzeStateRaw(makeDefaultAnalyzeState())
    setExploreStateRaw(makeDefaultExploreState())
    setCompareStateRaw(makeDefaultCompareState())
    resetSourceCounters()
  }

  function handleSendToCompare(anns: SharedAnnotation[]) {
    setPendingCompareAnns(anns)
    setPage('compare')
  }

  function handleGoScaffoldExplore(annotationId: string, source: string) {
    setExploreState(prev => ({
      ...prev,
      openSection:          'scaffolds',
      scaffoldInitialTerms: [{ annotationId, source }],
    }))
    setPage('explore')
  }

  function handleSendToAnalyze(annotationId: string) {
    setAnalyzeState(prev => ({
      ...prev,
      queryFields: [annotationId],
      // Clear previous results so search fires fresh
      resultsByTerm: [],
      totalsByTerm:  [],
      searchStatus:  'idle',
      activeTermIdx: 0,
      checkedByTerm: {},
    }))
    setPage('analyze')
  }

  return (
    <div className={sidebarOpen ? 'layout-sidebar-open' : 'layout-sidebar-closed'}>
      <header className="topbar">
        <div className="topbar-brand">
          <button className="sidebar-toggle-btn" onClick={() => setSidebarOpen(o => !o)}
            title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}>
            {sidebarOpen ? '◀' : '▶'}
          </button>
          <div className="logo-mark">⬡</div>
          <div className="brand-text">
            <span className="brand-name">HAB</span>
            <span className="brand-sub">Harmful Algal Bloom Portal</span>
          </div>
        </div>
        <div className="topbar-right">
          <ResetBtn onClick={handleReset} />
          <ModeToggle mode={uiMode} onToggle={() => setUiMode(m => m === 'basic' ? 'advanced' : 'basic')} />
          <ThemeToggle theme={theme} onToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} />
          {!indexReady && apiOnline && (
            <div className="api-status loading" title="Search index is building — searches still work but may be slower">
              <div className="dot" />
              <span>Building index…</span>
            </div>
          )}
          <div className={`api-status ${apiOnline === null ? 'loading' : apiOnline ? 'ok' : 'error'}`}>
            <div className="dot" />
            {apiOnline === null ? 'connecting…' : apiOnline ? 'API online' : 'API offline'}
          </div>
        </div>
      </header>

      <nav className={`sidebar ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
        {sidebarOpen && <div className="sidebar-section">Navigation</div>}
        {NAV_ITEMS.map(item => (
          <div key={item.id}
            className={`nav-item ${page === item.id ? 'active' : ''} ${!sidebarOpen ? 'nav-item-icon-only' : ''}`}
            onClick={() => setPage(item.id)}
            title={!sidebarOpen ? item.label : undefined}
          >
            <span className="nav-icon" dangerouslySetInnerHTML={{ __html: item.icon }} />
            {sidebarOpen && <span className="nav-label">{item.label}</span>}
          </div>
        ))}
        {sidebarOpen && (
          <div className="sidebar-footer">
            <p>128 metagenomic samples · JGI sequencing · HAB time series</p>
          </div>
        )}
      </nav>

      <main className="main">
        {/* All pages always mounted — display toggled so state never unmounts */}
        <div style={{ display: page === 'analyze' ? 'flex' : 'none', flexDirection: 'column', flex: 1 }}>
          <AnalyzePage
            state={analyzeState}
            setState={setAnalyzeState}
            indexReady={indexReady}
            uiMode={uiMode}
            onSendToCompare={handleSendToCompare}
            onGoScaffoldExplore={handleGoScaffoldExplore}
          />
        </div>
        <div style={{ display: page === 'compare' ? 'block' : 'none' }}>
          <ComparePage
            state={compareState}
            setState={setCompareState}
            initialAnnotations={pendingCompareAnns}
            onConsumed={() => setPendingCompareAnns([])}
          />
        </div>
        <div style={{ display: page === 'explore' ? 'block' : 'none' }}>
          <ExplorePage
            state={exploreState}
            setState={setExploreState}
            resetKey={resetKey}
            dataDateRange={dataDateRange}
            onSendToAnalyze={handleSendToAnalyze}
          />
        </div>
        <div style={{ display: page === 'about' ? 'block' : 'none' }}>
          <AboutPage />
        </div>
      </main>
    </div>
  )
}