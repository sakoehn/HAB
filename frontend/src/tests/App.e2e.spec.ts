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

  let body: any
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
    await expect(page.locator('.brand-name')).toHaveText('HAB')
    await expect(page.getByText('Harmful Algal Bloom Portal')).toBeVisible()
    await expect(page.locator('.api-status.ok')).toBeVisible()
  })

  test('navigates to Analyze, Compare, Explore, and About', async ({ page }) => {
    await goto(page)

    await page.locator('.nav-label', { hasText: 'Compare' }).click()
    await expect(page.locator('h1').filter({ hasText: /compare/i })).toBeVisible()

    await page.locator('.nav-label', { hasText: 'Explore' }).click()
    await expect(page.locator('h1').filter({ hasText: /explore/i })).toBeVisible()

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

  test('normalization controls update chart labels', async ({ page }) => {
    await openAnalyzeWithChart(page)

    await page.locator('.chart-card button').filter({ hasText: 'L1' }).first().click()
    await expect(page.locator('.chart-card').getByText(/norm_egc/i).first()).toBeVisible()

    await page.locator('.chart-card button').filter({ hasText: 'Z-score' }).first().click()
    await expect(page.locator('.chart-card').getByText(/Z-score/i).first()).toBeVisible()

    await page.locator('.chart-card button').filter({ hasText: 'Off' }).first().click()
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
    await expect(page.locator('.about-card, .page-body').getByText(/normalize modes/i).first()).toBeVisible()
    await expect(page.locator('.about-card').getByText(/lowess/i).first()).toBeVisible()
  })
})