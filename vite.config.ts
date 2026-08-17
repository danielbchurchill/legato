/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    // Without this, vitest's default recursive glob from repo root also
    // picks up server/src/**/*.spec.ts — a separate suite with its own
    // runner (npm --prefix server test), own conventions, and no reason to
    // run twice under two different configs.
    exclude: ['server/**', 'node_modules/**'],
  },
})
