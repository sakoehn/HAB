/**
 * hierarchy.e2e.spec.ts
 * =======================
 * Real-browser verification of the COG/Enzyme hierarchy popup against
 * the actual running FastAPI + Vite dev servers (see
 * playwright.config.ts's webServer entries -- both auto-start).
 *
 * Covers the multi-parent scenario: COG0028 is a real member of two COG
 * categories (E, Amino acid transport and metabolism; H, Coenzyme transport
 * and metabolism). Opening the popup from a real chart must auto-expand to
 * the first category, disclose the second via a picker, and let the user
 * switch to it. KEGG orthologs are a flat list, so a KO's chart card has
 * no Hierarchy button.
 *
 * Run: npx playwright test src/hierarchy.e2e.spec.ts
 */

import { test, expect } from '@playwright/test'

const COG0028_NAME = 'Acetolactate synthase large subunit or other thiamine pyrophosphate-requiring enzyme'

async function addChart(page: import('@playwright/test').Page, id: string) {
  await page.getByPlaceholder('e.g. iron, K02014, transport…').fill(id)
  await page.keyboard.press('Enter')
  const resultRow = page.locator('.al-row', { hasText: id }).first()
  await expect(resultRow).toBeVisible({ timeout: 15_000 })
  await resultRow.locator('.al-add-btn').click()
}

test('Hierarchy popup auto-expands to COG0028 and switches between its two categories', async ({ page }) => {
  await page.goto('/')

  // Analyze is the default page.
  await addChart(page, 'COG0028')

  // Chart card renders with the Hierarchy button alongside Scaffolds.
  const hierarchyBtn = page.getByTestId('hierarchy-btn').first()
  await expect(hierarchyBtn).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: 'test-results/hierarchy-chart-card.png' })

  await hierarchyBtn.click()

  const modal = page.getByTestId('hierarchy-modal')
  await expect(modal).toBeVisible()

  // Real multi-parent disclosure.
  await expect(page.getByTestId('multi-parent-note')).toContainText('2 real COG categories')

  // Auto-expanded to the first real category, with the leaf highlighted.
  // Scoped to the tree itself (.tax-tree), not the picker -- its <option>
  // text overlaps.
  const tree = modal.locator('.tax-tree')
  await expect(tree.getByText('Amino acid transport and metabolism')).toBeVisible()
  const highlighted = modal.locator('.tax-node-row.hier-node-highlighted')
  await expect(highlighted).toHaveCount(1)
  await expect(highlighted).toContainText(COG0028_NAME)

  await page.screenshot({ path: 'test-results/hierarchy-modal-expanded.png' })

  // Switch to the other category via the picker.
  await page.getByTestId('path-picker').selectOption('1')

  await expect(tree.getByText('Coenzyme transport and metabolism')).toBeVisible()
  await expect(highlighted).toHaveCount(1)
  await expect(highlighted).toContainText(COG0028_NAME)

  await page.screenshot({ path: 'test-results/hierarchy-modal-switched-path.png' })

  await page.getByTestId('close-btn').click()
  await expect(modal).not.toBeVisible()
})

test('A KEGG KO chart card has no Hierarchy button', async ({ page }) => {
  await page.goto('/')
  await addChart(page, 'K00844')
  await expect(page.getByTestId('scaffold-btn').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('hierarchy-btn')).toHaveCount(0)
})

test('Explore page tables show a Hierarchy column next to Scaffolds', async ({ page }) => {
  await page.goto('/')
  await page.locator('.nav-item', { hasText: 'Explore' }).click()

  // Explore has its own sub-sections -- the "Top EGC Annotations" table
  // (the one with the Hierarchy column) only renders after picking it,
  // choosing a non-taxonomy source (defaults to taxonomy), and clicking Load.
  await page.getByRole('button', { name: /Top EGC Annotations/ }).click()
  await page.getByRole('combobox').selectOption('cog')
  await page.getByRole('button', { name: 'Load', exact: true }).click()

  await expect(page.getByRole('columnheader', { name: 'Hierarchy' }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('columnheader', { name: 'Scaffolds' }).first()).toBeVisible()
  await page.screenshot({ path: 'test-results/explore-hierarchy-column.png' })
})
