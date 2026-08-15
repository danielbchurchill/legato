/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    // Without this, vitest's default recursive glob from repo root also
    // picks up server/src/**/*.spec.ts — a separate suite with its own
    // runner (npm --prefix server test), own conventions, and no reason to
    // run twice under two different configs.
    exclude: ['server/**', 'node_modules/**'],
  },
})
