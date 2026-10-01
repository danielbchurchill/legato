/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { shellWorker } from './scripts/vite-shell-worker.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), shellWorker()],
  // Pinned to IPv4 loopback: 'localhost' resolves IPv6-only on this
  // machine, so Vite was only listening on [::1]:5173. Airship's tunnel
  // upgrade path already works around Node's dual-stack "localhost"
  // ambiguity with autoSelectFamily, but its plain HTTP proxy path doesn't
  // — it can dial 127.0.0.1 and get refused, which is what was making
  // edits intermittently fail to reach the Tauri webview.
  server: {
    host: '127.0.0.1',
  },
  test: {
    // Root tests are the React app's only. server/ and relay/ each run their
    // own suite with their own node_modules (npm --prefix server test,
    // npm --prefix relay test), so a repo-wide glob either runs them twice or
    // fails to resolve their dependencies from here. An allowlist keeps the
    // next top-level package from breaking this the same way relay/ did.
    include: ['src/**/*.spec.{ts,tsx}'],
  },
})
