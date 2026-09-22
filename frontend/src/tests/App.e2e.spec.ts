/**
 * App.e2e.spec.ts
 * ===============
 * Focused Playwright E2E tests for the HAB Portal frontend.
 *
 * Goals:
 * - Keep the suite small and high-value.
 * - Verify real user workflows in a real browser.
 * - Avoid brittle CSS-only structure assertions where possible.
 * - Use a configurable known-good search term instead of assuming DB contents.
 *
 * Run with:
 *   E2E_SEARCH_TERM=iron npx playwright test src/tests/App.e2e.spec.ts
 */

import { test, expect, Page } from '@playwright/test'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'
const SEARCH_TERM = process.env.E2E_SEARCH_TERM ?? 'iron'

// ── Helpers ────────────────────────────────────────────────────────────────

async function goto(page: Page) {
  await page.goto(BASE_URL)
  await expect(page.locator('.api-status.ok, .api-status.error')).toBeVisible({ timeout: 20_000 })

  await page.waitForFunction(
    async () => {
      try {
        const r = await fetch('/api/status')
        const j = await r.json()
        return j.index_ready === true
      } catch {
        return false
      }
    },
    { timeout: 120_000, polling: 2000 },
  )
}

async function searchFor(page: Page, term: string) {
  const searchArea = page.locator('.al-search-area')
  await expect(searchArea).toBeVisible({ timeout: 10_000 })

  const input = searchArea.locator('input.field').first()
  await expect(input).toBeVisible()
  await input.fill(term)

  const responsePromise = page.waitForResponse((response) =>
    response.url().includes('/api/search/annotations') &&
    response.request().method() === 'GET' &&
    response.status() === 200
  )

  await page.getByRole('button', { name: /^search$/i }).click()

  const response = await responsePromise
  const bodyText = await response.text()

  let body: { data?: unknown[] }
  try {
    body = JSON.parse(bodyText)
  } catch {
    throw new Error(`Search API returned non-JSON body for "${term}": ${bodyText.slice(0, 1000)}`)
  }

  if (!body || !Array.isArray(body.data) || body.data.length === 0) {
    throw new Error(
      `Search term returned no results in this environment.\n` +
      `Set E2E_SEARCH_TERM to a known-good value before running this suite.\n` +
      `Query: ${term}\n` +
      `URL: ${response.url()}\n` +
      `Body: ${JSON.stringify(body, null, 2).slice(0, 4000)}`
    )
  }

  await expect(page.locator('.al-row').first()).toBeVisible({ timeout: 20_000 })
}

async function addFirstResultAsChart(page: Page) {
  const firstRow = page.locator('.al-row').first()
  await expect(firstRow).toBeVisible({ timeout: 10_000 })

  const addBtn = firstRow.locator('.al-add-btn')
  await expect(addBtn).toBeVisible()
  await addBtn.click()

  await expect(page.locator('.al-right-card').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.chart-card').first()).toBeVisible({ timeout: 15_000 })
}

async function openAnalyzeWithChart(page: Page) {
  await goto(page)
  await expect(page.getByText('Analyze Annotations')).toBeVisible()
  await searchFor(page, SEARCH_TERM)
  await addFirstResultAsChart(page)
}

// ── Suite ──────────────────────────────────────────────────────────────────

test.describe('HAB Portal E2E', () => {
  test('loads app shell and API is online', async ({ page }) => {
    await goto(page)
    await expect(page.locator('.brand-name')).toHaveText('Metatrace')
    await expect(page.getByText('Harmful Algal Bloom Metagenome Tracker')).toBeVisible()
    await expect(page.locator('.api-status.ok')).toBeVisible()
  })

  test('navigates to Analyze, Compare, Explore, and About', async ({ page }) => {
    await goto(page)

    await page.locator('.nav-label', { hasText: 'Compare' }).click()
    await expect(page.locator('h1').filter({ hasText: /compare/i })).toBeVisible()

    await page.locator('.nav-label', { hasText: 'Explore' }).click()
    // Exact text, not a substring regex — /explore/i also matches the
    // Taxonomy page's "Taxonomy Explorer" h1, which stays in the DOM
    // (hidden via CSS, not unmounted) since all pages mount simultaneously.
    await expect(page.getByText('Explore Annotations')).toBeVisible()

    await page.locator('.nav-label', { hasText: 'About' }).click()
    await expect(page.locator('h1').filter({ hasText: /about/i })).toBeVisible()

    await page.locator('.nav-label', { hasText: 'Analyze' }).click()
    await expect(page.getByText('Analyze Annotations')).toBeVisible()
  })

  test('theme toggle changes document theme', async ({ page }) => {
    await goto(page)
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    await page.getByTitle(/switch to/i).click()
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    expect(after).not.toBe(before)
    expect(['light', 'dark']).toContain(after)
  })

  test('sidebar collapse and expand works', async ({ page }) => {
    await goto(page)
    await page.getByTitle(/collapse sidebar/i).click()
    await expect(page.locator('.nav-label').first()).not.toBeVisible()
    await page.getByTitle(/expand sidebar/i).click()
    await expect(page.locator('.nav-label').first()).toBeVisible()
  })

  test('Analyze search returns visible results', async ({ page }) => {
    await goto(page)
    await expect(page.getByText('Analyze Annotations')).toBeVisible()
    await searchFor(page, SEARCH_TERM)
    await expect(page.locator('.al-row').first()).toBeVisible()
  })

  test('adding first search result creates a chart card', async ({ page }) => {
    await goto(page)
    await searchFor(page, SEARCH_TERM)
    await addFirstResultAsChart(page)
    await expect(page.locator('.al-right-card').first()).toBeVisible()
    await expect(page.locator('.chart-card svg').first()).toBeVisible()
  })

  test('chart card can be removed', async ({ page }) => {
    await goto(page)
    await searchFor(page, SEARCH_TERM)
    await addFirstResultAsChart(page)

    const closeBtn = page.locator('.al-card-close').first()
    await expect(closeBtn).toBeVisible()
    await closeBtn.click()

    await expect(page.locator('.al-right-card')).toHaveCount(0)
  })

  test('Metric and Standardize controls update chart labels independently', async ({ page }) => {
    await openAnalyzeWithChart(page)

    // Metric: Relative Abundance is already the default; clicking it is a no-op check
    await page.locator('.chart-card button').filter({ hasText: 'Relative Abundance' }).first().click()
    await expect(page.locator('.chart-card').getByText(/^Relative Abundance$/i).first()).toBeVisible()

    // Standardize: Off → Z-score, while metric stays Relative Abundance — a combination the
    // old mutually-exclusive Off/L1/Z-score control could never reach.
    await page.locator('.chart-card button').filter({ hasText: 'Z-score' }).first().click()
    await expect(page.locator('.chart-card').getByText(/Relative Abundance \(Z-score/i).first()).toBeVisible()

    // Standardize back to Off, metric still Relative Abundance
    await page.locator('.chart-card button').filter({ hasText: 'Off' }).first().click()
    await expect(page.locator('.chart-card').getByText(/^Relative Abundance$/i).first()).toBeVisible()

    // Metric back to EGC
    await page.locator('.chart-card button').filter({ hasText: 'EGC' }).first().click()
    await expect(page.locator('.chart-card').getByText(/^EGC$/i).first()).toBeVisible()
  })

  test('stats panel opens and shows core summary fields', async ({ page }) => {
    await openAnalyzeWithChart(page)

    const statsBtn = page.locator('button').filter({ hasText: /Σ Stats/i }).first()
    await expect(statsBtn).toBeVisible()
    await statsBtn.click()

    const panel = page.locator('.stats-panel').first()
    await expect(panel).toBeVisible()
    await expect(panel.getByText('n').first()).toBeVisible()
    await expect(panel.getByText('Mean').first()).toBeVisible()
    await expect(panel.getByText('Median').first()).toBeVisible()
    await expect(panel.getByText('Min').first()).toBeVisible()
    await expect(panel.getByText('Max').first()).toBeVisible()
  })

  test('CSV export downloads a csv with annotation data', async ({ page }) => {
    await openAnalyzeWithChart(page)

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.locator('.chart-card button').filter({ hasText: '↓ CSV' }).first().click(),
    ])

    expect(download.suggestedFilename()).toMatch(/\.csv$/)

    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const csv = Buffer.concat(chunks).toString('utf8')

    expect(csv).toContain('annotation_id')
    expect(csv).toContain('egc')
  })

  test('SVG export downloads an svg document', async ({ page }) => {
    await openAnalyzeWithChart(page)

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.locator('.chart-card button').filter({ hasText: '↓ SVG' }).first().click(),
    ])

    expect(download.suggestedFilename()).toMatch(/\.svg$/)

    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const svg = Buffer.concat(chunks).toString('utf8')

    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
  })

  test('About page explains EGC and normalization', async ({ page }) => {
    await goto(page)
    await page.locator('.nav-label', { hasText: 'About' }).click()
    await expect(page.locator('h1').filter({ hasText: /about/i })).toBeVisible()
    await expect(page.getByText(/Estimated Gene Copies/i).first()).toBeVisible()
    await expect(page.locator('.about-card, .page-body').getByText(/Relative Abundance/i).first()).toBeVisible()
    await expect(page.locator('.about-card').getByText(/lowess/i).first()).toBeVisible()
  })
})

// ── Chart zoom behavior ──────────────────────────────────────────────────────
// EgcChart/MultiEgcChart/GroupedEgcChart all render with Plotly and rely
// entirely on Plotly's native date-axis drag-zoom + rangeslider — there is
// no app-level zoom/brush state to unit-test (see
// multi-grouped-chart.unit.test.ts's header note for the history of the
// prior Recharts <Brush>/tickFormatter mechanism this replaced). A real
// browser + real Plotly render is the only way to verify zoom actually
// narrows the visible range and the chart doesn't break (blank trace,
// thrown error, NaN shape positions) when zoomed to a very narrow window.
// jsdom (used by the vitest unit/component suite) cannot render Plotly's
// canvas/SVG output at all, so this coverage has no unit-test equivalent.

declare global {
  interface Window {
    Plotly?: { Plots?: { resize?: (gd: HTMLElement) => void } }
  }
}

type PlotlyGraphDiv = HTMLElement & {
  _fullLayout?: { xaxis?: { range?: [string, string] } }
  data?: unknown[]
}

async function getXRange(plot: import('@playwright/test').Locator): Promise<[string, string]> {
  return plot.evaluate((el) => {
    const gd = el as PlotlyGraphDiv
    const range = gd._fullLayout?.xaxis?.range
    if (!range) throw new Error('Plotly xaxis range not available — chart not initialized?')
    return range
  })
}

function rangeSpanMs(range: [string, string]): number {
  return new Date(range[1]).getTime() - new Date(range[0]).getTime()
}

// Drags Plotly's actual interactive hit-rect (`.nsewdrag`), NOT the
// `.js-plotly-plot` container's own bounding box. The container includes
// margins, axis-label space, and the rangeslider strip, so coordinates
// computed from it land outside the draggable plotting area and Plotly
// silently ignores the gesture (confirmed by hand: dragging against the
// container bbox always produced an unchanged xaxis.range). The small
// waits between move/down/up steps were also required — without them
// Plotly's d3-based drag listener sometimes collapses the gesture into a
// click rather than a box-zoom-select.
async function dragZoom(
  page: import('@playwright/test').Page,
  dragRect: import('@playwright/test').Locator,
  x1Frac: number,
  x2Frac: number,
): Promise<void> {
  const box = await dragRect.boundingBox()
  if (!box) throw new Error('.nsewdrag bounding box not found')
  const y  = box.y + box.height / 2
  const x1 = box.x + box.width * x1Frac
  const x2 = box.x + box.width * x2Frac

  await page.mouse.move(x1, y)
  await page.mouse.down()
  await page.waitForTimeout(100)
  await page.mouse.move(x2, y, { steps: 5 })
  await page.waitForTimeout(100)
  await page.mouse.up()
  await page.waitForTimeout(400)
}

test.describe('Chart zoom behavior', () => {
  test('drag-zoom narrows the x-axis range and keeps the trace rendered', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('pageerror', (err) => consoleErrors.push(err.message))

    await openAnalyzeWithChart(page)

    const plot = page.locator('.chart-card .js-plotly-plot').first()
    await expect(plot).toBeVisible()
    await expect(plot.locator('.scatterlayer .trace').first()).toBeVisible()

    const rangeBefore = await getXRange(plot)
    await dragZoom(page, plot.locator('.nsewdrag').first(), 0.30, 0.55)

    const rangeAfter = await getXRange(plot)
    expect(rangeSpanMs(rangeAfter)).toBeLessThan(rangeSpanMs(rangeBefore))

    // Chart must still render its trace after zooming — not go blank.
    await expect(plot.locator('.scatterlayer .trace').first()).toBeVisible()
    expect(consoleErrors).toEqual([])
  })

  test('double-click resets zoom back to the full data range', async ({ page }) => {
    await openAnalyzeWithChart(page)

    const plot = page.locator('.chart-card .js-plotly-plot').first()
    await expect(plot).toBeVisible()

    const rangeBefore = await getXRange(plot)
    const dragRect = plot.locator('.nsewdrag').first()
    await dragZoom(page, dragRect, 0.30, 0.55)

    const zoomedRange = await getXRange(plot)
    expect(rangeSpanMs(zoomedRange)).toBeLessThan(rangeSpanMs(rangeBefore))

    // Plotly's default dblclick behavior resets the axis to autorange.
    await dragRect.dblclick({ position: { x: 5, y: 5 } })
    await page.waitForTimeout(400)

    const resetRange = await getXRange(plot)
    expect(rangeSpanMs(resetRange)).toBeGreaterThan(rangeSpanMs(zoomedRange))
    // Reset should restore (approximately) the original full span.
    expect(rangeSpanMs(resetRange)).toBeCloseTo(rangeSpanMs(rangeBefore), -2)
  })

  test('zooming to a very narrow window does not blank the chart or error', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('pageerror', (err) => consoleErrors.push(err.message))

    await openAnalyzeWithChart(page)

    const plot = page.locator('.chart-card .js-plotly-plot').first()
    await expect(plot).toBeVisible()

    const rangeBefore = await getXRange(plot)
    // A 2%-of-width drag over a ~24-day dataset zooms to roughly half a
    // day — a genuinely "heavily zoomed" window, not just a slight zoom.
    await dragZoom(page, plot.locator('.nsewdrag').first(), 0.50, 0.52)

    const rangeAfter = await getXRange(plot)
    expect(rangeSpanMs(rangeAfter)).toBeLessThan(rangeSpanMs(rangeBefore))
    // Confirm this really is a "heavy" zoom: well under one day visible.
    expect(rangeSpanMs(rangeAfter)).toBeLessThan(24 * 60 * 60 * 1000)

    // The plot container and its axes must still be present — not a blank
    // or crashed widget — even at an extreme zoom level.
    await expect(plot).toBeVisible()
    // Two .xaxislayer-above groups exist (main plot + rangeslider mini-plot).
    await expect(plot.locator('.xaxislayer-above').first()).toBeVisible()
    await expect(plot.locator('.scatterlayer .trace').first()).toBeVisible()
    expect(consoleErrors).toEqual([])
  })

  test('enabling night shading while heavily zoomed adds shapes without errors', async ({ page }) => {
    // Test order: zoom first, THEN enable night shading — this validates that
    // computeNightBands() + toPlotlyDate() produce valid shape coordinates
    // when the dataset is heavily zoomed (narrow xaxis.range), and that
    // Plotly renders those shapes without throwing or blanking the chart.
    // (Order: toggle-first-then-zoom is a separate interaction path that
    // Playwright's synthetic CDP events cannot reliably trigger against
    // Plotly's d3-drag listener in this environment — excluded here.)
    const consoleErrors: string[] = []
    page.on('pageerror', (err) => consoleErrors.push(err.message))

    await openAnalyzeWithChart(page)

    const plot = page.locator('.chart-card .js-plotly-plot').first()
    await expect(plot).toBeVisible()

    // Zoom in heavily first (proven-reliable interaction, matches test 3).
    await dragZoom(page, plot.locator('.nsewdrag').first(), 0.50, 0.52)
    const narrowRange = await getXRange(plot)
    expect(rangeSpanMs(narrowRange)).toBeLessThan(24 * 60 * 60 * 1000)

    // Now enable Day/Night shading while zoomed — this triggers a
    // computeNightBands() call against the zoomed date range and a
    // Plotly.react() update with new shapes. If band timestamps or
    // toPlotlyDate() produce NaN/invalid values, Plotly throws.
    const dayNightBtn = page.locator('.chart-card button').filter({ hasText: 'Day/Night' }).first()
    await expect(dayNightBtn).toBeVisible()
    await dayNightBtn.click()
    await page.waitForTimeout(600)

    // Chart must remain rendered (not blank/crashed) and show night shapes.
    await expect(plot).toBeVisible()
    await expect(plot.locator('.shapelayer').first()).toBeVisible()
    const shapeCount = await plot.evaluate(
      (el: Element & { _fullLayout?: { shapes?: unknown[] } }) => el._fullLayout?.shapes?.length ?? 0
    )
    expect(shapeCount).toBeGreaterThan(0)
    expect(consoleErrors).toEqual([])
  })

  test('rangeslider is present with the expected handle structure', async ({ page }) => {
    // Validates structural presence of the rangeslider and its min/max
    // grab handles, confirming the Plotly layout config actually emits
    // the rangeslider strip (thickness:0.06, visible:true).
    // Note: programmatically dragging the rangeslider handle via synthetic
    // CDP mouse events is unreliable in this environment due to Plotly's
    // d3-drag distance thresholds differing between a real browser session
    // and Playwright's CDP-dispatched synthetic events. Manual or visual
    // testing is more appropriate for verifying the rangeslider's drag
    // behavior as a zoom control (though computeNightBands/alignment
    // correctness at any resulting range is validated by tests 3 & 4).
    await openAnalyzeWithChart(page)

    const plot = page.locator('.chart-card .js-plotly-plot').first()
    await expect(plot).toBeVisible()

    const slider = plot.locator('.rangeslider-container').first()
    await expect(slider).toBeVisible()
    await expect(plot.locator('.rangeslider-grabarea-min').first()).toBeVisible()
    await expect(plot.locator('.rangeslider-grabarea-max').first()).toBeVisible()
    await expect(plot.locator('.rangeslider-slidebox').first()).toBeVisible()
  })
})