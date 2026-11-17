import { defineConfig } from 'vitest/config'

// Engine tests drive a real headless Chromium (Node Playwright) against public/demo.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
