import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { SectionLabel } from '../ui/SectionLabel'
import { Spinner } from '../ui/Spinner'
import { StatusDot } from '../ui/StatusDot'
import { formatCount, plural } from '../ui/format'
import { useTouchLayout } from '../ui/touchLayout'
import { BackRow, PanelHeader } from '../shell/SidePanel'
import { API_BASE as API } from '../config/serverHost'
import { useLoadingWait } from '../library/useLoadingWait'
import { MatchBar } from './ImportPlaylist'

/* Apple Music's Library.xml, through Collections' import page (#133), in
 * the M3U import's three steps: what Legato found, Import, then a report.
 *
 * The server does the matching (server/src/applemusic/import.ts): each
 * track by its path, then by its path under another folder (a library
 * copied to a NAS), then by artist, title and length. What comes over is
 * the playlists the person made, Music's play counts (one total per track,
 * replacing an earlier import's), and its ratings and dates added, which
 * are kept for when Legato shows them.
 *
 * Tracks in the Apple Music library that were never downloaded have no
 * file to play, so the report lists them with Apple's page on downloading
 * them, rather than leaving them out without a word (H9). */

// Apple's Music User Guide, "Add and download music on Mac". The desktop
// app's opener allows this guide (src-tauri/capabilities/default.json).
export const DOWNLOAD_HELP_URL = 'https://support.apple.com/guide/music/add-and-download-music-mus02acedfe/mac'

type Remap = { from: string; to: string; tracks: number }
type PlaylistPlan = { name: string; tracks: number; matched: number; status: 'new' | 'already-imported' }
type ListedTrack = { name: string | null; artist: string | null; album: string | null; location: string | null }

export type Preview = {
  tracks: number
  matchedByLocation: number
  matchedByMetadata: number
  notFound: number
  cloudOnly: number
  setAside: number
  remaps: Remap[]
  plays: { tracks: number; total: number }
  ratings: number
  datesAdded: number
  playlists: PlaylistPlan[]
  skippedPlaylists: { smart: number; builtIn: number; folders: number }
}

export type Result = Omit<Preview, 'playlists'> & {
  playlists: (PlaylistPlan & { playlistId: number | null })[]
  cloudOnlyTracks: ListedTrack[]
  notFoundTracks: ListedTrack[]
}

async function send<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: file })
  if (res.ok) return res.json() as Promise<T>
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.status === 413) throw new Error('That file is bigger than the server takes (256 MB).')
  throw new Error(body.error ?? `The server couldn't read it (${res.status}).`)
}

function segments(p: Omit<Preview, 'playlists'>) {
  return [
    { value: p.matchedByLocation, color: 'var(--color-ink)', label: 'by location' },
    { value: p.matchedByMetadata, color: 'var(--color-ink-2)', label: 'by artist and title' },
    { value: p.cloudOnly, color: 'var(--color-ink-3)', label: 'in the cloud only' },
    { value: p.notFound, color: 'var(--color-bad)', label: 'not found' },
  ]
}

function Legend({ preview }: { preview: Omit<Preview, 'playlists'> }) {
  return (
    <div className="mt-[8px] flex flex-wrap gap-x-[14px] gap-y-[2px] text-small text-[var(--color-ink-2)]">
      {segments(preview).map((s) => (
        <span key={s.label}>
          <span className="mono text-[var(--color-ink)]">{formatCount(s.value)}</span> {s.label}
        </span>
      ))}
    </div>
  )
}

export function AppleMusicImport({
  file,
  onBack,
  onOpenPlaylist,
}: {
  file: File
  onBack: () => void
  onOpenPlaylist: (id: number) => void
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const wait = useLoadingWait(busy)

  useEffect(() => {
    let cancelled = false
    send<Preview>(`${API}/apple-music/import/preview`, file)
      .then((value) => !cancelled && setPreview(value))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setBusy(false))
    return () => {
      cancelled = true
    }
  }, [file])

  const commit = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await send<Result>(`${API}/apple-music/import?filename=${encodeURIComponent(file.name)}`, file))
    } catch (err) {
      setError(err instanceof Error ? `${err.message} Nothing was imported.` : 'The import failed. Nothing was imported.')
    } finally {
      setBusy(false)
    }
  }

  const errorLine = error && (
    <p role="alert" className="mt-[12px] text-small [overflow-wrap:anywhere] text-[var(--color-bad)]">
      {error}
    </p>
  )

  if (result) return <Report result={result} onBack={onBack} onOpenPlaylist={onOpenPlaylist} />

  return (
    <div className="flex flex-col">
      <BackRow label="Collections" onBack={onBack} />
      <PanelHeader title="Import from Apple Music" />
      <div className="mt-[14px] flex items-center gap-[10px]">
        <Icon name="library" size={18} className="text-[var(--color-ink-2)]" />
        <span
          className="min-w-0 flex-1 truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]"
          title={file.name}
        >
          {file.name}
        </span>
        {preview && (
          <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{plural(preview.tracks, 'track')}</span>
        )}
        {!preview && wait.visible && <Spinner label="reading the library" className="text-[var(--color-ink-2)]" />}
      </div>

      {preview && (
        <>
          <div className="mt-[14px]">
            <MatchBar segments={segments(preview)} />
          </div>
          <Legend preview={preview} />
          {preview.remaps.map((remap) => (
            <div
              key={remap.from}
              className="mt-[16px] flex flex-col gap-[6px] rounded-[var(--radius-card)] bg-[var(--color-wash)] p-[12px]"
            >
              <span className="flex items-center gap-[8px]">
                <StatusDot status="accent" />
                <span className="text-heading text-[var(--color-ink)]">Found under another folder</span>
              </span>
              <span className="mono text-[length:var(--text-mono)] [overflow-wrap:anywhere] text-[var(--color-ink)]">
                {remap.from} → {remap.to}
              </span>
              <span className="text-small text-[var(--color-ink-2)]">
                {plural(remap.tracks, 'track')} found where Music's paths would be on this server.
              </span>
            </div>
          ))}

          <SectionLabel className="mt-[18px] h-[24px]">what comes over</SectionLabel>
          <ul className="flex flex-col gap-[6px] text-small text-[var(--color-ink-2)]">
            <li>
              <span className="mono text-[var(--color-ink)]">{formatCount(preview.plays.total)}</span>{' '}
              {preview.plays.total === 1 ? 'play' : 'plays'} on {plural(preview.plays.tracks, 'track')}
            </li>
            {preview.playlists.map((p) => (
              <li key={p.name} className="flex items-baseline justify-between gap-[10px]">
                <span className="min-w-0 truncate text-[var(--color-ink)]" title={p.name}>
                  {p.name}
                </span>
                <span className="shrink-0">
                  {p.status === 'already-imported' ? (
                    'already imported'
                  ) : p.tracks === 0 ? (
                    'empty'
                  ) : (
                    <>
                      <span className="mono text-[var(--color-ink)]">{formatCount(p.matched)}</span> of {plural(p.tracks, 'track')}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-[12px] text-small [text-wrap:pretty] text-[var(--color-ink-3)]">
            Music's play counts replace any imported before; plays Legato counted itself stay and add to them. Ratings and dates added are
            kept too. Smart playlists and Music's own lists aren't imported.
          </p>
          {errorLine}
          <div className="mt-[14px] flex gap-[8px]">
            <Button variant="primary" disabled={busy} onClick={() => void commit()}>
              Import
            </Button>
            <Button variant="secondary" onClick={onBack}>
              Cancel
            </Button>
          </div>
          {busy && wait.visible && <span className="mt-[8px] text-small text-[var(--color-ink-3)]">importing…</span>}
        </>
      )}
      {!preview && errorLine}
    </div>
  )
}

function Report({ result, onBack, onOpenPlaylist }: { result: Result; onBack: () => void; onOpenPlaylist: (id: number) => void }) {
  const found = result.matchedByLocation + result.matchedByMetadata
  // On a phone the link takes taps across 44px, as a Button does there.
  const touch = useTouchLayout()
  return (
    <div className="flex flex-col">
      <BackRow label="Collections" onBack={onBack} />
      <PanelHeader title="Imported from Apple Music" />
      <p className="mt-[8px] text-small text-[var(--color-ink-2)]">
        <span className="mono text-[var(--color-ink)]">{formatCount(found)}</span> of {plural(result.tracks, 'track')} found ·{' '}
        <span className="mono text-[var(--color-ink)]">{formatCount(result.plays.total)}</span>{' '}
        {result.plays.total === 1 ? 'play' : 'plays'}
      </p>
      <div className="mt-[12px]">
        <MatchBar segments={segments(result)} />
      </div>
      <Legend preview={result} />

      {result.playlists.length > 0 && (
        <section className="mt-[18px]">
          <SectionLabel className="h-[24px]" count={result.playlists.length}>
            playlists
          </SectionLabel>
          <ul>
            {result.playlists.map((p) => (
              <li key={p.name} className="flex items-center justify-between gap-[10px] border-b border-[var(--color-line)] py-[8px]">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
                    {p.name}
                  </span>
                  <span className="text-small text-[var(--color-ink-2)]">
                    {p.playlistId == null
                      ? 'already imported, left as it is'
                      : p.tracks === 0
                        ? 'empty'
                        : `${formatCount(p.matched)} of ${plural(p.tracks, 'track')}`}
                  </span>
                </span>
                {p.playlistId != null && (
                  <Button variant="secondary" size="sm" onClick={() => onOpenPlaylist(p.playlistId!)}>
                    Open
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.cloudOnly > 0 && (
        <TrackList
          label="in the cloud only"
          count={result.cloudOnly}
          tracks={result.cloudOnlyTracks}
          explain={
            <>
              In your Apple Music library, but not downloaded to the Mac it came from, so there's no file for Legato to play. Download them
              in Music, put them in a folder Legato reads, then import again.{' '}
              <a
                href={DOWNLOAD_HELP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={`relative inline-block font-medium whitespace-nowrap text-[var(--color-ink)] underline-offset-2 hover:underline ${touch ? 'touch-target' : ''}`}
              >
                How to download music in Music
              </a>
            </>
          }
        />
      )}
      {result.notFound > 0 && (
        <TrackList
          label="not found"
          count={result.notFound}
          tracks={result.notFoundTracks}
          explain="Music has a file for these, but not in a folder Legato reads. Add their folder in Settings, then import again."
        />
      )}
      <div className="mt-[16px]">
        <Button variant="secondary" onClick={onBack}>
          Done
        </Button>
      </div>
    </div>
  )
}

function TrackList({ label, count, tracks, explain }: { label: string; count: number; tracks: ListedTrack[]; explain: ReactNode }) {
  return (
    <section className="mt-[18px]">
      <SectionLabel className="h-[24px]" count={formatCount(count)}>
        {label}
      </SectionLabel>
      <p className="mb-[6px] text-small [text-wrap:pretty] text-[var(--color-ink-2)]">{explain}</p>
      <ul>
        {tracks.map((t, i) => (
          <li key={i} title={t.location ?? undefined} className="flex flex-col border-b border-[var(--color-line)] py-[8px]">
            <span className="text-[length:var(--text-body)] leading-[20px] font-medium [overflow-wrap:anywhere] text-[var(--color-ink)]">
              {t.name ?? 'Untitled'}
            </span>
            <span className="text-small [overflow-wrap:anywhere] text-[var(--color-ink-2)]">
              {[t.artist, t.album].filter(Boolean).join(' · ')}
            </span>
          </li>
        ))}
      </ul>
      {count > tracks.length && (
        <p className="mt-[6px] text-small text-[var(--color-ink-3)]">and {plural(count - tracks.length, 'more track')}</p>
      )}
    </section>
  )
}
