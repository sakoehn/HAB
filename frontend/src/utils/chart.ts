// ── Chart Export Utilities ────────────────────────────────────────────────────
// DOM-dependent functions for exporting Recharts SVGs to PNG and SVG files.
// These are the only utility functions that require a browser environment —
// do not import in Node/test contexts.
//
// Both functions work by:
//   1. Cloning the live SVG from the chart container ref
//   2. Inserting a white background rect
//   3. Resolving CSS variables to concrete hex values
//   4. Inlining resolved colors onto clone elements
//   5. Serialising and triggering a download
//
// The color resolution pass is necessary because Recharts sets colors as
// element *attributes* (stroke="#38d9b4"), not CSS, so getComputedStyle
// returns the browser default black for unset SVG properties.

import type React from 'react'

// ── Shared color constants for export ─────────────────────────────────────
// These match the light-theme values so exported charts look clean on white.

const EXPORT_BG_COLOR   = '#ffffff'
const EXPORT_TEXT_COLOR = '#1e293b'
const EXPORT_GRID_COLOR = '#e2e8f0'
const EXPORT_AXIS_COLOR = '#94a3b8'
const EXPORT_DIM_COLOR  = '#64748b'

// ── resolveCssVar ──────────────────────────────────────────────────────────
// Replace var(--name) tokens in a CSS value string with their computed
// values from :root.  Results are cached to avoid repeated getComputedStyle
// calls across the many elements in a chart.

function resolveCssVar(val: string, cache: Record<string, string>): string {
  if (!val || !val.includes('var(')) return val
  return val.replace(/var\(([^)]+)\)/g, (_, name) => {
    const k = name.trim()
    if (!cache[k]) {
      cache[k] = getComputedStyle(document.documentElement)
        .getPropertyValue(k)
        .trim()
    }
    return cache[k] || '#888888'
  })
}

// ── resolveAttrColor ──────────────────────────────────────────────────────
// Resolve a fill or stroke color for one live SVG element.
// Priority: explicit attribute → inline style → computed style.
// Computed style is only trusted when it is not the browser default black,
// which SVG elements inherit when no rule applies.

function resolveAttrColor(
  liveEl:  Element,
  prop:    'fill' | 'stroke',
  cache:   Record<string, string>,
): string | null {
  // 1. Explicit attribute (how Recharts sets line/dot colors)
  const attr = liveEl.getAttribute(prop)
  if (attr && attr !== 'none' && attr !== 'transparent') {
    return resolveCssVar(attr, cache)
  }

  // 2. Inline style property
  const styleVal = (liveEl as HTMLElement).style?.[prop]
  if (styleVal && styleVal !== 'none') {
    return resolveCssVar(styleVal, cache)
  }

  // 3. Computed style — skip browser-default black
  const computed = window.getComputedStyle(liveEl)
  const cv       = prop === 'fill' ? computed.fill : computed.stroke
  if (
    cv &&
    cv !== 'rgb(0, 0, 0)' &&
    cv !== 'rgba(0, 0, 0, 0)' &&
    cv !== 'none'
  ) {
    return resolveCssVar(cv, cache)
  }

  return null
}

// ── inlineColorsOntoClone ──────────────────────────────────────────────────
// Walk all drawable SVG elements in the live chart and copy resolved colors
// onto the corresponding clone elements.
//
// bgRectOffset accounts for the white background rect inserted at index 0
// of the clone — all subsequent clone indices are shifted by 1 relative to
// the live SVG's querySelectorAll results.

const SVG_DRAWABLE =
  'path, line, polyline, polygon, rect, circle, ellipse, text, tspan'

function inlineColorsOntoClone(
  svg:   SVGSVGElement,
  clone: SVGSVGElement,
  cache: Record<string, string>,
): void {
  const liveEls  = Array.from(svg.querySelectorAll(SVG_DRAWABLE))   as Element[]
  const cloneEls = Array.from(clone.querySelectorAll(SVG_DRAWABLE)) as SVGElement[]
  const offset   = 1 // bgRect sits at cloneEls[0]

  liveEls.forEach((liveEl, i) => {
    const cloneEl = cloneEls[i + offset]
    if (!cloneEl) return

    const tag = liveEl.tagName.toLowerCase()
    const cls = liveEl.getAttribute('class') ?? ''

    // Recharts uses rects only for backgrounds — strip all fills
    if (tag === 'rect') {
      cloneEl.setAttribute('fill',   'none')
      cloneEl.setAttribute('stroke', 'none')
      return
    }

    // Text — always force to dark readable color
    if (tag === 'text' || tag === 'tspan') {
      const computed = window.getComputedStyle(liveEl)
      cloneEl.setAttribute('fill',        EXPORT_TEXT_COLOR)
      cloneEl.setAttribute('stroke',      'none')
      cloneEl.setAttribute('font-family', 'monospace')
      cloneEl.setAttribute('font-size',   computed.fontSize || '11px')
      return
    }

    // Grid lines
    if (cls.includes('recharts-cartesian-grid')) {
      cloneEl.setAttribute('stroke', EXPORT_GRID_COLOR)
      cloneEl.setAttribute('fill',   'none')
      return
    }

    // Axis lines and ticks
    if (
      cls.includes('recharts-cartesian-axis') ||
      cls.includes('recharts-xAxis') ||
      cls.includes('recharts-yAxis')
    ) {
      const fill   = resolveAttrColor(liveEl, 'fill',   cache)
      const stroke = resolveAttrColor(liveEl, 'stroke', cache)
      cloneEl.setAttribute('fill',   fill   ?? EXPORT_DIM_COLOR)
      cloneEl.setAttribute('stroke', stroke ?? EXPORT_AXIS_COLOR)
      return
    }

    // All other elements — resolve fill and stroke from attributes
    const fill   = resolveAttrColor(liveEl, 'fill',   cache)
    const stroke = resolveAttrColor(liveEl, 'stroke', cache)

    // Strip area-fill paths (background fills, not data lines).
    // Data line paths always have an explicit stroke set by Recharts.
    const fillOpacity = liveEl.getAttribute('fill-opacity')
    const isAreaFill  =
      tag === 'path' &&
      (
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

    cloneEl.removeAttribute('style')
  })
}

// ── buildClone ─────────────────────────────────────────────────────────────
// Create a clean SVG clone with a white background rect prepended.
// Strips any inline style on the root element that Recharts may have set.

function buildClone(svg: SVGSVGElement, width: number, height: number): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('width',  String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns',  'http://www.w3.org/2000/svg')
  clone.removeAttribute('style')

  const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bgRect.setAttribute('x',      '0')
  bgRect.setAttribute('y',      '0')
  bgRect.setAttribute('width',  String(width))
  bgRect.setAttribute('height', String(height))
  bgRect.setAttribute('fill',   EXPORT_BG_COLOR)
  clone.insertBefore(bgRect, clone.firstChild)

  return clone
}

// ── downloadChartPng ───────────────────────────────────────────────────────
// Export the chart as a 2× retina PNG with an optional title strip.
// Renders at 2× scale via canvas for crisp output on high-DPI displays.

export function downloadChartPng(
  containerRef: React.RefObject<HTMLDivElement>,
  filename:     string,
  title?:       string,
): void {
  const node = containerRef.current
  if (!node) return
  const svg = node.querySelector('svg')
  if (!svg) return

  const { width, height } = svg.getBoundingClientRect()
  const TITLE_H  = title ? 40 : 0
  const PADDING  = 20
  const canvasW  = width  + PADDING * 2
  const canvasH  = height + PADDING * 2 + TITLE_H

  const cache = {} as Record<string, string>
  const clone = buildClone(svg, width, height)
  inlineColorsOntoClone(svg, clone, cache)

  const svgData = new XMLSerializer().serializeToString(clone)
  const svgB64  = btoa(unescape(encodeURIComponent(svgData)))
  const dataUri = `data:image/svg+xml;base64,${svgB64}`
  const img     = new Image()

  img.onload = () => {
    const scale  = 2
    const canvas = document.createElement('canvas')
    canvas.width  = canvasW * scale
    canvas.height = canvasH * scale
    const ctx     = canvas.getContext('2d')!
    ctx.scale(scale, scale)

    ctx.fillStyle = EXPORT_BG_COLOR
    ctx.fillRect(0, 0, canvasW, canvasH)

    if (title) {
      ctx.fillStyle = EXPORT_TEXT_COLOR
      ctx.font      = `600 13px 'IBM Plex Mono', monospace`
      ctx.textAlign = 'left'
      ctx.fillText(title, PADDING, PADDING + 18)
    }

    ctx.drawImage(img, PADDING, PADDING + TITLE_H, width, height)

    const a    = document.createElement('a')
    a.download = filename
    a.href     = canvas.toDataURL('image/png')
    a.click()
  }

  img.onerror = (e) => console.error('PNG export failed:', e)
  img.src = dataUri
}

// ── downloadChartSvg ───────────────────────────────────────────────────────
// Export the chart as an SVG file with white background and optional title.
// SVG output is smaller than PNG and resolution-independent — preferred for
// publication figures.

export function downloadChartSvg(
  containerRef: React.RefObject<HTMLDivElement>,
  filename:     string,
  title?:       string,
): void {
  const node = containerRef.current
  if (!node) return
  const svg = node.querySelector('svg')
  if (!svg) return

  const { width, height } = svg.getBoundingClientRect()
  const TITLE_H = title ? 28 : 0
  const PADDING = 16
  const totalW  = width  + PADDING * 2
  const totalH  = height + PADDING * 2 + TITLE_H

  const clone = buildClone(svg, totalW, totalH)
  clone.removeAttribute('style')

  if (title) {
    const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    titleEl.setAttribute('x',           String(PADDING))
    titleEl.setAttribute('y',           String(PADDING + 16))
    titleEl.setAttribute('fill',        EXPORT_TEXT_COLOR)
    titleEl.setAttribute('font-family', "'IBM Plex Mono', monospace")
    titleEl.setAttribute('font-size',   '12')
    titleEl.setAttribute('font-weight', '600')
    titleEl.textContent = title
    clone.insertBefore(titleEl, clone.children[1])
  }

  // Wrap chart content in a translated group to apply padding
  const g      = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  const offset = title ? 2 : 1
  g.setAttribute('transform', `translate(${PADDING}, ${PADDING + TITLE_H})`)
  while (clone.children.length > offset) g.appendChild(clone.children[offset])
  clone.appendChild(g)

  // Resolve any remaining CSS variable references in stroke/fill attributes
  clone.querySelectorAll('[stroke]').forEach(el => {
    const s = el.getAttribute('stroke') ?? ''
    if (s.includes('var(--border)'))   el.setAttribute('stroke', EXPORT_GRID_COLOR)
    if (s.includes('var(--text-dim)')) el.setAttribute('stroke', EXPORT_AXIS_COLOR)
  })
  clone.querySelectorAll('text').forEach(el => {
    if ((el.getAttribute('fill') ?? '').includes('var(')) {
      el.setAttribute('fill', EXPORT_TEXT_COLOR)
    }
  })

  const svgData = new XMLSerializer().serializeToString(clone)
  const blob    = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
  const url     = URL.createObjectURL(blob)
  const a       = document.createElement('a')
  a.href        = url
  a.download    = filename
  a.click()
  URL.revokeObjectURL(url)
}
