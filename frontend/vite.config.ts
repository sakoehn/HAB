import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/vitest.setup.ts'],
    globals: true,
    css: false,
    // Component tests that render the whole app take ~2s on an idle machine
    // and ~5x that when the machine is busy (e.g. a CI runner); the 5s
    // default made them fail at random there. 15s leaves room for that
    // while still catching a genuinely hung test.
    testTimeout: 15_000,
    environmentOptions: {
      jsdom: {
        url: 'http://localhost',
      },
    },
    exclude: [
    '**/node_modules/**',
    '**/*.e2e.spec.ts',
    ],
  },
})