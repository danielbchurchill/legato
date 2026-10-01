import { useEffect, useState } from 'react'
import { API_BASE as API, SERVER_HOST } from '../config/serverHost'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Spinner } from '../ui/Spinner'

/* The folder picker for a server that isn't on this machine (issue #121):
 * browses the server's own disks through GET /fs/browse, where Tauri's
 * native dialog could only ever show this machine's. folderPicker.ts
 * decides which of the two "add folder" opens.
 *
 * Clicking a folder goes into it; "add this folder" adds the one being
 * shown. Each row carries the server's shallow count (audio files and
 * folders directly inside), which is what tells "Music" from "Music (old
 * rips)" without opening both. */

type BrowseEntry = { name: string; path: string; audioFiles: number | null; folders: number | null }
type BrowseListing = {
  path: string | null
  parent: string | null
  docker: boolean
  audioFiles: number | null
  entries: BrowseEntry[]
}

const DOCKER_DOCS = 'https://github.com/danielbchurchill/legato/blob/main/docs/install/docker.md#adding-another-folder'

// DESIGN.md's progress rule: say nothing for a wait under ~400ms.
const SPINNER_DELAY_MS = 400

export function ServerFolderPicker({
  open,
  onClose,
  onChoose,
}: {
  open: boolean
  onClose: () => void
  onChoose: (path: string) => void
}) {
  // The folders walked into, most recent last; empty is the list of roots.
  // Kept apart from the listing, so "up" from a folder that failed to load
  // still knows where it came from.
  const [trail, setTrail] = useState<string[]>([])
  const target = trail.at(-1)
  const [listing, setListing] = useState<BrowseListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [slow, setSlow] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // Every open starts back at the roots, not wherever the last one ended.
  useEffect(() => {
    if (open) setTrail([])
  }, [open])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const query = target === undefined ? '' : `?path=${encodeURIComponent(target)}`
    fetch(`${API}/fs/browse${query}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? `server returned ${res.status}`)
        setListing(body as BrowseListing)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [open, target, attempt])

  useEffect(() => {
    if (!loading) {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), SPINNER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [loading])

  // While a request is out, the rows shown are still the previous folder's;
  // they stay up (no flash to empty), but can't be acted on.
  const current = !loading && !error ? listing : null
  const docker = listing?.docker ?? false

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="choose a music folder"
      className="w-[560px] max-w-[calc(100vw-var(--spacing-lg)*2)]"
      description={
        docker ? (
          <p>
            You're seeing the folders mounted into Legato's container. To add another, edit the compose file and
            recreate the container.{' '}
            <a
              href={DOCKER_DOCS}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-ink)] hover:text-[var(--color-muted-hi)]"
            >
              how to add a folder
            </a>
          </p>
        ) : (
          <p>
            Folders on the server at <span className="font-[family-name:var(--font-mono)]">{SERVER_HOST}</span>.
          </p>
        )
      }
      footer={
        <>
          <Button onClick={onClose}>cancel</Button>
          <Button
            onClick={() => current?.path && onChoose(current.path)}
            disabled={!current?.path}
            className="disabled:text-[var(--color-muted)]"
          >
            add this folder
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--spacing-sm)]">
        <div className="flex min-h-[24px] items-center gap-[var(--spacing-sm)]">
          {target !== undefined && (
            <Button onClick={() => setTrail((t) => t.slice(0, -1))}>
              up
            </Button>
          )}
          <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[var(--color-ink)]">
            {target ?? <span className="font-[family-name:var(--font-ui)] text-[var(--color-muted)]">starting points</span>}
          </span>
          {current?.audioFiles != null && current.audioFiles > 0 && <Count n={current.audioFiles} unit="audio files here" />}
          {slow && <Spinner label="loading folders" className="text-[var(--color-muted)]" />}
        </div>
        <div className="h-px w-full bg-[var(--color-divider)]" />

        {error ? (
          <div className="flex flex-col items-start gap-[var(--spacing-sm)] py-[var(--spacing-sm)]">
            <p className="text-[var(--color-muted)]">{error}</p>
            <Button onClick={() => setAttempt((n) => n + 1)}>try again</Button>
          </div>
        ) : listing && listing.entries.length === 0 && !loading ? (
          <p className="py-[var(--spacing-sm)] text-[var(--color-muted)]">
            {listing.path === null ? 'This server has no folders to offer.' : 'No folders inside this one.'}
          </p>
        ) : (
          <ul className={`flex max-h-[360px] flex-col ${loading ? 'opacity-50' : ''}`} aria-busy={loading}>
            {listing?.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => setTrail((t) => [...t, entry.path])}
                  className="grid min-h-[var(--spacing-row)] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--spacing-sm)] rounded-[var(--radius-small)] px-[var(--spacing-xs)] text-left hover:bg-[var(--color-hover-wash)]"
                >
                  <span className="truncate font-[family-name:var(--font-mono)] text-[var(--color-ink)]">
                    {entry.name}
                  </span>
                  <EntryCounts entry={entry} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}

/* The numbers are data about the disk (mono ink); the words around them
 * are labels (Rubik muted). DESIGN.md "The one rule". */
function Count({ n, unit }: { n: number; unit: string }) {
  return (
    <span className="whitespace-nowrap text-[var(--color-muted)]">
      <span className="font-[family-name:var(--font-mono)] text-[var(--color-ink)]">{n}</span> {unit}
    </span>
  )
}

function EntryCounts({ entry }: { entry: BrowseEntry }) {
  if (entry.audioFiles === null || entry.folders === null) {
    // The server gave up on reading it in time, or couldn't read it.
    return <span className="whitespace-nowrap text-[var(--color-muted)]">didn't answer</span>
  }
  if (entry.audioFiles > 0) return <Count n={entry.audioFiles} unit={entry.audioFiles === 1 ? 'audio file' : 'audio files'} />
  if (entry.folders > 0) return <Count n={entry.folders} unit={entry.folders === 1 ? 'folder' : 'folders'} />
  return <span className="whitespace-nowrap text-[var(--color-muted)]">empty</span>
}
