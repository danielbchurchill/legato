import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Button } from '../ui/Button'
import { API_BASE as API } from '../config/serverHost'
import { FOLDER_PICKER } from './folderPicker'
import { ServerFolderPicker } from './ServerFolderPicker'

/* First run: no music folder yet. Three placeholder covers, one sentence
 * on what Legato does with a folder, and the one button. It sits in the
 * shell's own stage rather than taking over the window, so the first thing
 * anyone sees is the app they're about to use.
 *
 * Adding a folder starts the scan server-side (library-roots.ts's POST); the
 * caller switches to the map, whose first-scan card takes it from there.
 *
 * The native folder dialog only when the server is on this machine;
 * otherwise a browser of the server's own folders (issue #121). */

type LibraryRoot = { id: number; path: string; label: string | null }

export function AddMusic({ onAdded }: { onAdded?: (root: LibraryRoot) => void }) {
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const addRoot = async (path: string) => {
    setBusy(true)
    try {
      const res = await fetch(`${API}/library-roots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `The server couldn't add that folder (${res.status}).`)
        return
      }
      onAdded?.((await res.json()) as LibraryRoot)
    } finally {
      setBusy(false)
    }
  }

  const chooseFolder = async () => {
    setError(null)
    if (FOLDER_PICKER === 'server') {
      setPickerOpen(true)
      return
    }
    const selected = await open({ directory: true, multiple: false })
    if (!selected || Array.isArray(selected)) return
    await addRoot(selected)
  }

  return (
    <div className="mx-auto mt-[120px] flex max-w-[440px] flex-col items-center gap-[14px] text-center">
      <div aria-hidden="true" className="flex items-center gap-[10px]">
        <span className="size-[72px] rounded-[8px] bg-[var(--color-wash-2)] shadow-[var(--shadow-art-edge)]" />
        <span className="size-[96px] rounded-[8px] bg-[var(--color-wash)] shadow-[var(--shadow-art-edge)]" />
        <span className="size-[72px] rounded-[8px] bg-[var(--color-wash-2)] shadow-[var(--shadow-art-edge)]" />
      </div>
      <h1 className="text-title text-[var(--color-ink)]">Add your music</h1>
      <p className="text-[15px] leading-[22px] [text-wrap:pretty] text-[var(--color-ink-2)]">
        Point Legato at a folder. It reads the tags, matches every track, and draws your map.
      </p>
      <Button variant="primary" size="lg" icon="add" onClick={() => void chooseFolder()} disabled={busy} className="mt-[4px]">
        Choose a folder
      </Button>
      {error ? (
        <p role="alert" className="text-small [overflow-wrap:anywhere] text-[var(--color-bad)]">
          {error}
        </p>
      ) : (
        <span className="text-small text-[var(--color-ink-3)]">You can add more folders later in Settings.</span>
      )}
      <ServerFolderPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onChoose={(path) => {
          setPickerOpen(false)
          void addRoot(path)
        }}
      />
    </div>
  )
}
