import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { selectShellFiles, type ShellManifest } from '../src/pwa/shellPolicy.ts'

/* Builds src/pwa/worker.ts to dist/sw.js (#128) and stamps it with the shell
 * manifest: the list of files it precaches, plus a content hash of all of
 * them as its version.
 *
 * The version is what replaces the worker on a deploy. Browsers re-fetch
 * sw.js on every navigation (the server sends it no-cache, like any
 * unhashed file) and install a new worker only when its bytes change, so a
 * build that changes any shell file has to change sw.js too. Hashing
 * contents rather than names covers the unhashed files as well, index.html
 * and public/ alike.
 *
 * Build only. `vite` (dev) never emits a worker, and main.tsx never
 * registers one there either. */

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listFiles(full, base)
    return [path.relative(base, full).split(path.sep).join('/')]
  })
}

export function shellWorker(): Plugin {
  let root = ''
  let outDir = ''
  return {
    name: 'legato-shell-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root
      outDir = path.resolve(config.root, config.build.outDir)
    },
    buildStart() {
      // A separate chunk, so it never shares code with the app's own: a
      // classic service worker script can't import a module chunk.
      this.emitFile({ type: 'chunk', id: path.resolve(root, 'src/pwa/worker.ts'), fileName: 'sw.js' })
    },
    // closeBundle, not writeBundle: public/ is copied into dist/ separately,
    // and its files are part of the shell too.
    closeBundle() {
      const workerPath = path.join(outDir, 'sw.js')
      if (!existsSync(workerPath)) return
      const files = selectShellFiles(listFiles(outDir))
      const hash = createHash('sha256')
      for (const file of files) {
        hash.update(file)
        hash.update(readFileSync(path.join(outDir, file)))
      }
      const manifest: ShellManifest = { version: hash.digest('hex').slice(0, 16), files }
      const worker = readFileSync(workerPath, 'utf8')
      writeFileSync(workerPath, `self.__LEGATO_SHELL_MANIFEST__ = ${JSON.stringify(manifest)};\n${worker}`)
    },
  }
}
