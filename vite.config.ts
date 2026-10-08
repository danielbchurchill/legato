/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { shellWorker } from './scripts/vite-shell-worker.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), shellWorker()],
  // Pinned to IPv4 loopback: 'localhost' can resolve IPv6-only, which left
  // Vite listening only on [::1]:5173 while the Tauri webview (devUrl) and
  // anything else dialling 127.0.0.1 got refused.
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
    // Vitest blanks every .css import, ?raw included. canvasCopies.spec.ts
    // reads tokens.css as text to check the hand copies of its canvas
    // colour (#291); a plain import of a stylesheet stays blank.
    css: { include: [/\/src\/styles\/tokens\.css\?raw$/] },
  },
})
