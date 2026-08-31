import { useEffect, useState, type ReactNode } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { useWsEvent } from './hooks/useWs'
import { Button } from './ui/Button'
import { SERVER_HOST } from './config/serverHost'
import { IS_TAURI } from './config/runtime'

const API = `http://${SERVER_HOST}:8899/api/v1`

type LibraryRoot = { id: number; path: string; label: string | null }
type ScanProgress = { libraryRootId: number; filesScanned: number; filesTotal: number }

/* First-run — takes over the whole window per DESIGN.md's empty-state
 * catalogue. Once a root is added, the initial scan already starts itself
 * server-side (library-roots.ts's POST handler) — this just watches it
 * happen over the same scan:progress/scan:done events the settings screen
 * uses, then hands off to the canvas once real data exists to show. */
export default function LibrarySetup({ onLibraryReady }: { onLibraryReady: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [scanningRoot, setScanningRoot] = useState<LibraryRoot | null>(null)
  const [filesScanned, setFilesScanned] = useState(0)
  const [filesTotal, setFilesTotal] = useState(0)

  useWsEvent(['scan:progress'], (payload) => {
    const p = payload as ScanProgress
    if (scanningRoot && p.libraryRootId === scanningRoot.id) {
      setFilesScanned(p.filesScanned)
      setFilesTotal(p.filesTotal)
    }
  })
  // MO-11: the walk that builds filesTotal has no known length itself —
  // genuinely indeterminate. Nothing shown for the first stretch (the
  // "scanning…" label already acknowledged the click); past 800ms, one
  // non-looping colour shift says the wait is still real without pretending
  // to know its length. Once filesTotal arrives this never fires again.
  const [longWait, setLongWait] = useState(false)
  useEffect(() => {
    if (!scanningRoot || filesTotal > 0) {
      setLongWait(false)
      return
    }
    const t = setTimeout(() => setLongWait(true), 800)
    return () => clearTimeout(t)
  }, [scanningRoot, filesTotal])

  // A failed initial scan still leaves a real (if empty or partial) library
  // — DESIGN.md puts scan-failure handling on the canvas, not here, so this
  // hands off either way rather than stranding the user on this screen.
  useWsEvent(['scan:done', 'scan:error'], (payload) => {
    const p = payload as { libraryRootId: number }
    if (scanningRoot && p.libraryRootId === scanningRoot.id) onLibraryReady()
  })

  const chooseFolder = async () => {
    if (!IS_TAURI) return
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
    setFilesTotal(0)
    setScanningRoot(root)
  }

  return (
    <Centered>
      <span className="font-[family-name:var(--font-display)] text-[length:var(--text-wordmark)] leading-none text-[var(--color-ink)]">
        legato
      </span>

      {scanningRoot ? (
        filesTotal > 0 ? (
          <div className="flex w-full max-w-[360px] flex-col items-center gap-[8px]">
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
              scanning {scanningRoot.label ?? scanningRoot.path}…{' '}
              <span className="font-[family-name:var(--font-mono)] text-[var(--color-muted-hi)]">
                {filesScanned}/{filesTotal}
              </span>
            </p>
            <div className="h-[3px] w-full overflow-hidden rounded-full bg-[var(--color-divider)]">
              <div
                className="h-full rounded-full bg-[var(--color-signal)]"
                style={{ width: `${Math.min(100, (filesScanned / filesTotal) * 100)}%` }}
              />
            </div>
          </div>
        ) : (
          <p
            className={`text-[length:var(--text-base)] transition-colors duration-[var(--motion-fast)] ${
              longWait ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)]'
            }`}
          >
            scanning {scanningRoot.label ?? scanningRoot.path}…
          </p>
        )
      ) : (
        <>
          <p className="max-w-[420px] text-[length:var(--text-base)] text-[var(--color-muted)]">
            {IS_TAURI
              ? 'No music library configured yet. Choose a folder to scan.'
              : 'No music library configured yet. Adding one needs the desktop app — open Legato there first, then come back to preview it.'}
          </p>
          {IS_TAURI && <Button onClick={() => void chooseFolder()}>choose music folder</Button>}
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
