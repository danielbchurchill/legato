import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// One entry per page. Vite only builds index.html unless told otherwise,
// and Cloudflare Pages serves dist/privacy.html at /privacy, so each legal
// page is just another HTML entry sharing the same stylesheet.
export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        privacy: resolve(import.meta.dirname, 'privacy.html'),
        terms: resolve(import.meta.dirname, 'terms.html'),
      },
    },
  },
});
