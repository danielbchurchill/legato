import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Button } from '../ui/Button'
import { SectionLabel } from '../ui/SectionLabel'
import { Shimmer } from '../ui/Skeleton'
import { API_BASE as API } from '../config/serverHost'
import { FOLDER_PICKER } from './folderPicker'
import { countParts, displayPath, suggestionName, useFolderSuggestions, type FolderSuggestion } from './folderSuggestions'
import { ServerFolderPicker } from './ServerFolderPicker'
import { useLoadingWait } from './useLoadingWait'

/* First run: no music folder yet. Three placeholder covers, one sentence
 * on what Legato does with a folder, and the one button. It sits in the
 * shell's own stage rather than taking over the window, so the first thing
 * anyone sees is the app they're about to use.
 *
 * Adding a folder starts the scan server-side (library-roots.ts's POST); the
 * caller switches to the map, whose first-scan card takes it from there.
 *
 * Before the button, the folders on the server that look like a library,
 * each with a quick count (issue #132), so the likely answer is one click
 * rather than a path to remember. Picking one adds it exactly as the button
 * would. With suggestions on offer, the button steps down to "Choose another
 * folder"; with none, it's the one way in, as before.
 *
 * The native folder dialog only when the server is on this machine;
 * otherwise a browser of the server's own folders (issue #121). */

type LibraryRoot = { id: number; path: string; label: string | null }

export function AddMusic({ onAdded, phone = false }: { onAdded?: (root: LibraryRoot) => void; phone?: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const found = useFolderSuggestions()
  // DESIGN.md's progress rule: nothing for a quick answer, a signal for a
  // slow one (a network share being counted).
  const wait = useLoadingWait(found.loading)
  const offered = found.suggestions.length > 0

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

  const block = (
    <div
      className={`mx-auto flex w-full max-w-[480px] flex-col items-center gap-[14px] px-[20px] text-center ${
        phone ? 'min-h-full justify-center py-[24px]' : 'mt-[120px]'
      }`}
    >
      <div aria-hidden="true" className="flex items-center gap-[10px]">
        <span className="size-[72px] rounded-[8px] bg-[var(--color-wash-2)] shadow-[var(--shadow-art-edge)]" />
        <span className="size-[96px] rounded-[8px] bg-[var(--color-wash)] shadow-[var(--shadow-art-edge)]" />
        <span className="size-[72px] rounded-[8px] bg-[var(--color-wash-2)] shadow-[var(--shadow-art-edge)]" />
      </div>
      <h1 className="text-title text-[var(--color-ink)]">Add your music</h1>
      <p className="text-[15px] leading-[22px] [text-wrap:pretty] text-[var(--color-ink-2)]">
        Point Legato at a folder. It reads the tags, matches every track, and draws your map.
      </p>
      {offered ? (
        <section className="mt-[6px] flex w-full flex-col gap-[8px] text-left" aria-label="Suggested folders">
          <SectionLabel>{FOLDER_PICKER === 'native' ? 'found on this computer' : 'found on the server'}</SectionLabel>
          <ul className="flex flex-col gap-[6px]">
            {found.suggestions.map((suggestion) => (
              <li key={suggestion.path}>
                <SuggestionRow
                  suggestion={suggestion}
                  home={found.home}
                  disabled={busy}
                  onPick={() => {
                    setError(null)
                    void addRoot(suggestion.path)
                  }}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        wait.visible && (
          <span className="text-small text-[var(--color-ink-3)]">
            <Shimmer>looking for music…</Shimmer>
          </span>
        )
      )}
      <Button
        variant={offered ? 'secondary' : 'primary'}
        size="lg"
        icon="add"
        onClick={() => void chooseFolder()}
        disabled={busy}
        className="mt-[4px]"
      >
        {offered ? 'Choose another folder' : 'Choose a folder'}
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
  // On a phone the block has only the map's room between the controls and
  // the sheet. It centres there, and scrolls when the suggestions make it
  // taller than that, rather than running under the sheet.
  return phone ? <div className="h-full overflow-y-auto">{block}</div> : block
}

/* One suggested folder: what it's called over where it is, and how much
 * music is in it. The name is a name (Rubik), the path and the count are
 * data off the disk (mono). */
function SuggestionRow({
  suggestion,
  home,
  disabled,
  onPick,
}: {
  suggestion: FolderSuggestion
  home: string | null
  disabled: boolean
  onPick: () => void
}) {
  const count = countParts(suggestion)
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      title={suggestion.path}
      className="grid min-h-[52px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[12px] rounded-[var(--radius-card)] bg-[var(--color-wash)] px-[14px] py-[8px] text-left transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:bg-[var(--color-wash-2)] disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body font-medium text-[var(--color-ink)]">{suggestionName(suggestion)}</span>
        <span className="mono truncate text-[length:var(--text-mono)] text-[var(--color-ink-3)]">{displayPath(suggestion.path, home)}</span>
      </span>
      <span className="text-small whitespace-nowrap text-[var(--color-ink-2)]">
        {count.before}
        <span className="mono text-[var(--color-ink)]">{count.number}</span>
        {count.after}
      </span>
    </button>
  )
}
