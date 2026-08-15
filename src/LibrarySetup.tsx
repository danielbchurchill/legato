import { useState, type ReactNode } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useWsEvent } from './hooks/useWs'

const API = 'http://127.0.0.1:8899/api/v1'

type LibraryRoot = { id: number; path: string; label: string | null }
type ScanProgress = { libraryRootId: number; filesScanned: number }

/* First-run — takes over the whole window per DESIGN.md's empty-state
 * catalogue. Once a root is added, the initial scan already starts itself
 * server-side (library-roots.ts's POST handler) — this just watches it
 * happen over the same scan:progress/scan:done events the settings screen
 * uses, then hands off to the canvas once real data exists to show. */
export default function LibrarySetup({ onLibraryReady }: { onLibraryReady: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [scanningRoot, setScanningRoot] = useState<LibraryRoot | null>(null)
  const [filesScanned, setFilesScanned] = useState(0)

  useWsEvent(['scan:progress'], (payload) => {
    const p = payload as ScanProgress
    if (scanningRoot && p.libraryRootId === scanningRoot.id) setFilesScanned(p.filesScanned)
  })
  // A failed initial scan still leaves a real (if empty or partial) library
  // — DESIGN.md puts scan-failure handling on the canvas, not here, so this
  // hands off either way rather than stranding the user on this screen.
  useWsEvent(['scan:done', 'scan:error'], (payload) => {
    const p = payload as { libraryRootId: number }
    if (scanningRoot && p.libraryRootId === scanningRoot.id) onLibraryReady()
  })

  const chooseFolder = async () => {
    setError(null)
    const selected = await open({ directory: true, multiple: false })
    if (!selected || Array.isArray(selected)) return

    const res = await fetch(`${API}/library-roots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selected }),
    })
    if (!res.ok) {
      const body = await res.json()
      setError(body.error ?? `server returned ${res.status}`)
      return
    }
    const root = (await res.json()) as LibraryRoot
    setFilesScanned(0)
    setScanningRoot(root)
  }

  return (
    <Centered>
      <span className="font-[family-name:var(--font-display)] text-[length:var(--text-wordmark)] leading-none text-[var(--color-ink)]">
        legato
      </span>

      {scanningRoot ? (
        <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
          scanning {scanningRoot.label ?? scanningRoot.path}… {filesScanned} files
        </p>
      ) : (
        <>
          <p className="max-w-[420px] text-[length:var(--text-base)] text-[var(--color-muted)]">
            No music library configured yet. Choose a folder to scan.
          </p>
          <button
            type="button"
            onClick={() => void chooseFolder()}
            className="text-[length:var(--text-base)] text-[var(--color-ink)] underline decoration-[var(--color-hairline)] underline-offset-2 hover:text-[var(--color-muted)]"
          >
            choose music folder
          </button>
          {error && <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">{error}</p>}
        </>
      )}
    </Centered>
  )
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-[12px] bg-[var(--color-canvas)] p-[24px] text-center text-[length:var(--text-base)] text-[var(--color-ink)]">
      {children}
    </div>
  )
}
