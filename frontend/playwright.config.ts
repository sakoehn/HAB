/**
 * playwright.config.ts
 * ====================
 * Place this file at:  frontend/playwright.config.ts
 *
 * Uses import.meta.url instead of __dirname because this project
 * uses ES modules ("type": "module" in package.json). __dirname does
 * not exist in ESM scope — that was the ReferenceError you saw.
 */

import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'url'
import path from 'path'

// ESM-safe equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const FRONTEND_PORT = Number(process.env.FRONTEND_PORT ?? 5173)
const BACKEND_PORT  = Number(process.env.BACKEND_PORT  ?? 8000)

const BASE_URL = process.env.BASE_URL ?? `http://localhost:${FRONTEND_PORT}`

// main.py lives in FastAPI/, a sibling of frontend/ — NOT the repo root.
// (Previously resolved to '..', the repo root, which has no main.py; that
// made webServer auto-start always fail with "Could not import module
// main" unless a backend happened to already be running beforehand.)
const BACKEND_DIR = path.resolve(__dirname, '..', 'FastAPI')

export default defineConfig({
  testDir:  './src',
  testMatch: '**/*.e2e.spec.ts',

  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL:           BASE_URL,
    headless:          true,
    viewport:          { width: 1280, height: 900 },
    trace:             'on-first-retry',
    screenshot:        'only-on-failure',
    actionTimeout:     15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use:  { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    // ── FastAPI backend ──────────────────────────────────────────────────
    {
      command: `cd /d "${BACKEND_DIR}" && python -m uvicorn main:app --port ${BACKEND_PORT} --log-level warning`,
      url: `http://localhost:${BACKEND_PORT}/status`,
      reuseExistingServer: true,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    // ── Vite dev server ──────────────────────────────────────────────────
    {
      command: 'npm run dev',
      url:     BASE_URL,
      reuseExistingServer: true,
      timeout: 30_000,
      stdout:  'pipe',
      stderr:  'pipe',
    },
  ],
})