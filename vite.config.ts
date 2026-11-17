import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Vitest reuses this file; the engine's tests run on Node Playwright and must not boot workerd.
export default defineConfig({
  plugins: [react(), ...(process.env.VITEST ? [] : [cloudflare()])],
})
