/**
 * hierarchy.e2e.spec.ts
 * =======================
 * Real-browser verification of the KEGG/COG/Enzyme hierarchy popup against
 * the actual running FastAPI (DATA_BACKEND=sql) + Vite dev servers (see
 * playwright.config.ts's webServer entries -- both auto-start).
 *
 * Covers the flagship scenario this feature was built for: K00844
 * (hexokinase) has 14 real KEGG pathway parents (the E14 multi-parent bug
 * fixed earlier this audit) -- opening the popup from a real chart must
 * auto-expand to the Glycolysis path specifically (not an arbitrary one),
 * disclose the multi-parent count via a picker, and let the user switch to
 * a different real path (e.g. Fructose and mannose metabolism).
 *
 * Run: npx playwright test src/hierarchy.e2e.spec.ts
 */

import { test, expect } from '@playwright/test'

test('Hierarchy popup auto-expands to K00844\'s Glycolysis path and highlights it', async ({ page }) => {
  await page.goto('/')

  // Analyze is the default page.
  await page.getByPlaceholder('e.g. iron, K02014, transport…').fill('K00844')
  await page.keyboard.press('Enter')

  const resultRow = page.locator('.al-row', { hasText: 'K00844' }).first()
  await expect(resultRow).toBeVisible({ timeout: 15_000 })
  await resultRow.locator('.al-add-btn').click()

  // Chart card renders with the Hierarchy button alongside Scaffolds.
  const hierarchyBtn = page.getByTestId('hierarchy-btn').first()
  await expect(hierarchyBtn).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: 'test-results/hierarchy-chart-card.png' })

  await hierarchyBtn.click()

  const modal = page.getByTestId('hierarchy-modal')
  await expect(modal).toBeVisible()

  // Real E14 multi-parent disclosure.
  await expect(page.getByTestId('multi-parent-note')).toContainText('14 real KEGG pathways')

  // Auto-expanded down the real, file-order-first path. Scoped to the tree
  // itself (.tax-tree), not the picker -- its <option> text overlaps.
  const tree = modal.locator('.tax-tree')
  await expect(tree.getByText('Metabolism', { exact: true })).toBeVisible()
  await expect(tree.getByText('Carbohydrate metabolism')).toBeVisible()
  await expect(tree.getByText('Glycolysis', { exact: false })).toBeVisible()

  // Leaf row highlighted -- "HK; hexokinase" specifically (not a substring
  // match, since a sibling "KHK; ketohexokinase" also contains "hexokinase").
  const leafRow = modal.locator('.tax-node-row', { hasText: 'HK; hexokinase' })
  await expect(leafRow).toHaveClass(/hier-node-highlighted/)

  await page.screenshot({ path: 'test-results/hierarchy-modal-expanded.png' })

  // Switch to a different one of K00844's 14 real paths via the picker
  // (index 1 = Fructose and mannose metabolism, confirmed by direct query
  // in tests/sql/test_cache_sql.py -- paths are sorted by real file order).
  await page.getByTestId('path-picker').selectOption('1')

  await expect(tree.getByText('Fructose and mannose metabolism')).toBeVisible()
  // Still under the shared ancestor, still highlighted, just a different branch.
  await expect(tree.getByText('Carbohydrate metabolism')).toBeVisible()
  const leafRowAfterSwitch = modal.locator('.tax-node-row', { hasText: 'HK; hexokinase' })
  await expect(leafRowAfterSwitch).toHaveClass(/hier-node-highlighted/)

  await page.screenshot({ path: 'test-results/hierarchy-modal-switched-path.png' })

  await page.getByTestId('close-btn').click()
  await expect(modal).not.toBeVisible()
})

test('Explore page tables show a Hierarchy column next to Scaffolds', async ({ page }) => {
  await page.goto('/')
  await page.locator('.nav-item', { hasText: 'Explore' }).click()

  // Explore has its own sub-sections -- the "Top EGC Annotations" table
  // (the one with the Hierarchy column) only renders after picking it,
  // choosing a non-taxonomy source (defaults to taxonomy), and clicking Load.
  await page.getByRole('button', { name: /Top EGC Annotations/ }).click()
  await page.getByRole('combobox').selectOption('kegg')
  await page.getByRole('button', { name: 'Load' }).click()

  await expect(page.getByRole('columnheader', { name: 'Hierarchy' }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('columnheader', { name: 'Scaffolds' }).first()).toBeVisible()
  await page.screenshot({ path: 'test-results/explore-hierarchy-column.png' })
})
