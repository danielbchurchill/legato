import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { open } from '@tauri-apps/plugin-dialog'

const API = 'http://127.0.0.1:8899/api/v1'

type LibraryRoot = {
  id: number
  path: string
  label: string | null
  enabled: number
  added_at: string
}

// Real (non-debug) app entry point for M0: prove the folder-picker -> DB
// round trip works end to end. Canvas/article/playback views land in
// M3-M6 — this is intentionally just enough UI to configure a library.
export default function LibrarySetup() {
  const [roots, setRoots] = useState<LibraryRoot[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    const res = await fetch(`${API}/library-roots`)
    setRoots(await res.json())
  }

  useEffect(() => {
    refresh()
  }, [])

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
    await refresh()
  }

  if (roots === null) {
    return <Centered>loading library configuration…</Centered>
  }

  return (
    <Centered>
      <h2 style={{ marginTop: 0 }}>Legato</h2>
      {roots.length === 0 ? (
        <p style={{ opacity: 0.7, maxWidth: 420 }}>
          No music library configured yet. Choose a folder to scan.
        </p>
      ) : (
        <ul style={{ textAlign: 'left', listStyle: 'none', padding: 0 }}>
          {roots.map((r) => (
            <li key={r.id}>{r.label ?? r.path}</li>
          ))}
        </ul>
      )}
      <button onClick={chooseFolder} style={buttonStyle}>
        {roots.length === 0 ? 'Choose music folder' : 'Add another folder'}
      </button>
      {error && <p style={{ color: '#f66' }}>{error}</p>}
    </Centered>
  )
}

const buttonStyle: CSSProperties = {
  padding: '8px 16px',
  fontFamily: 'monospace',
  fontSize: 14,
  cursor: 'pointer',
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        background: '#111',
        color: '#fff',
        fontFamily: 'monospace',
        textAlign: 'center',
        padding: 24,
      }}
    >
      {children}
    </div>
  )
}
