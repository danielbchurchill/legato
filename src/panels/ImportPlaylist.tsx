import { useRef, useState, type DragEvent } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Mosaic } from '../ui/Mosaic'
import { SectionLabel } from '../ui/SectionLabel'
import { StatusDot } from '../ui/StatusDot'
import { formatCount, plural } from '../ui/format'
import { BackRow, PanelHeader } from '../shell/SidePanel'
import { API_BASE as API } from '../config/serverHost'

/* Playlist import, in three steps on one page: pick an .m3u, preview how
 * much of it Legato can find, then a report of what was added.
 *
 * Matching is the server's (routes/playlist-import.ts): by file path first,
 * then by artist and title from the #EXTINF line. The preview only checks
 * paths; when most of them miss under one common prefix — a playlist made
 * on another machine — it offers the rewrite that would find them, and
 * re-previews with it applied. Nothing is written until Import. */

type PathRemap = { from: string; to: string }
type Suggestion = { libraryRootId: number; libraryRootPath: string; replacement: string; previewMatchCount: number }
type Preview = {
  totalEntries: number
  matchedByPath: number
  unmatchedByPath: number
  commonPrefix: string | null
  suggestions: Suggestion[]
}
type Entry = {
  position: number
  rawPath: string
  extinfArtist: string | null
  extinfTitle: string | null
  matchType: 'path' | 'metadata' | 'missing'
  matchedNodeId: number | null
  reason: string | null
}
type Result = { playlist: { id: number; name: string }; entries: Entry[] }

async function fetchPreview(content: string, remap: PathRemap | null): Promise<Preview> {
  const res = await fetch(`${API}/playlists/import/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, remap }),
  })
  if (!res.ok) throw new Error('preview failed')
  return res.json()
}

/* An 8px bar of segments with 2px gaps between them, each segment's width
 * its share of the whole. */
function MatchBar({ segments }: { segments: { value: number; color: string; label: string }[] }) {
  const total = segments.reduce((n, s) => n + s.value, 0) || 1
  return (
    <div
      role="img"
      aria-label={segments.map((s) => `${s.value} ${s.label}`).join(', ')}
      className="flex h-[8px] gap-[2px] overflow-hidden rounded-full"
    >
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <span key={s.label} className="h-full" style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
        ))}
    </div>
  )
}

export function ImportPlaylist({ onBack, onOpenPlaylist }: { onBack: () => void; onOpenPlaylist: (id: number) => void }) {
  const [file, setFile] = useState<{ name: string; content: string } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [remap, setRemap] = useState<PathRemap | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const pick = async (picked: File) => {
    setError(null)
    setBusy(true)
    try {
      const content = await picked.text()
      setPreview(await fetchPreview(content, null))
      setFile({ name: picked.name, content })
      setRemap(null)
    } catch {
      setError("That file couldn't be read as a playlist. It needs to be an .m3u or .m3u8.")
    } finally {
      setBusy(false)
    }
  }

  const applySuggestion = async (suggestion: Suggestion) => {
    if (!file || !preview?.commonPrefix) return
    const candidate = { from: preview.commonPrefix, to: suggestion.replacement }
    setBusy(true)
    setError(null)
    try {
      setPreview(await fetchPreview(file.content, candidate))
      setRemap(candidate)
    } catch {
      setError("Couldn't re-check with that rewrite. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API}/playlists/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content: file.content, remap }),
      })
      if (!res.ok) throw new Error()
      setResult((await res.json()) as Result)
    } catch {
      setError('The import failed. Nothing was added; try again.')
    } finally {
      setBusy(false)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) void pick(dropped)
  }

  const errorLine = error && (
    <p role="alert" className="mt-[12px] text-small text-[var(--color-bad)]">
      {error}
    </p>
  )

  if (result) {
    const byPath = result.entries.filter((e) => e.matchType === 'path').length
    const byMeta = result.entries.filter((e) => e.matchType === 'metadata').length
    const missing = result.entries.filter((e) => e.matchType === 'missing')
    const matched = result.entries.filter((e) => e.matchedNodeId != null).map((e) => e.matchedNodeId!)
    return (
      <div className="flex flex-col">
        <BackRow label="Collections" onBack={onBack} />
        <PanelHeader title="Imported" />
        <div className="mt-[12px] flex items-center gap-[12px]">
          <Mosaic nodeIds={matched.slice(0, 4)} size={56} />
          <div className="flex min-w-0 flex-col">
            <span className="text-heading [overflow-wrap:anywhere] text-[var(--color-ink)]">{result.playlist.name}</span>
            <span className="text-small text-[var(--color-ink-2)]">
              {formatCount(byPath + byMeta)} of {plural(result.entries.length, 'track')} added
            </span>
          </div>
        </div>
        <div className="mt-[16px]">
          <MatchBar
            segments={[
              { value: byPath, color: 'var(--color-ink)', label: 'by path' },
              { value: byMeta, color: 'var(--color-ink-2)', label: 'by artist and title' },
              { value: missing.length, color: 'var(--color-bad)', label: 'missing' },
            ]}
          />
        </div>
        <div className="mt-[8px] flex flex-wrap gap-x-[14px] text-small text-[var(--color-ink-2)]">
          <span>{formatCount(byPath)} by path</span>
          <span>{formatCount(byMeta)} by artist and title</span>
          <span>{formatCount(missing.length)} missing</span>
        </div>
        {missing.length > 0 && (
          <section className="mt-[16px]">
            <SectionLabel className="h-[24px]">missing</SectionLabel>
            <ul>
              {missing.map((entry) => {
                const fileName = entry.rawPath.split(/[\\/]/).pop() ?? entry.rawPath
                return (
                  <li key={entry.position} title={entry.rawPath} className="flex flex-col border-b border-[var(--color-line)] py-[8px]">
                    <span className="text-[length:var(--text-body)] leading-[20px] font-medium [overflow-wrap:anywhere] text-[var(--color-ink)]">
                      {entry.extinfTitle ?? fileName}
                    </span>
                    <span className="text-small text-[var(--color-ink-2)]">
                      {[entry.extinfArtist, entry.reason].filter(Boolean).join(' · ')}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        <div className="mt-[14px]">
          <Button variant="primary" icon="play" onClick={() => onOpenPlaylist(result.playlist.id)}>
            Open playlist
          </Button>
        </div>
      </div>
    )
  }

  if (file && preview) {
    const suggestion = remap ? null : preview.suggestions[0]
    return (
      <div className="flex flex-col">
        <BackRow label="Collections" onBack={onBack} />
        <PanelHeader title="Import playlist" />
        <div className="mt-[14px] flex items-center gap-[10px]">
          <Icon name="list" size={18} className="text-[var(--color-ink-2)]" />
          <span
            className="min-w-0 flex-1 truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]"
            title={file.name}
          >
            {file.name}
          </span>
          <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{plural(preview.totalEntries, 'track')}</span>
        </div>
        <div className="mt-[14px]">
          <MatchBar
            segments={[
              { value: preview.matchedByPath, color: 'var(--color-ink)', label: 'found by path' },
              { value: preview.unmatchedByPath, color: 'var(--color-wash-2)', label: 'not found' },
            ]}
          />
        </div>
        <div className="mt-[8px] flex justify-between text-small text-[var(--color-ink-2)]">
          <span>{formatCount(preview.matchedByPath)} found by path</span>
          <span>{formatCount(preview.unmatchedByPath)} not found</span>
        </div>
        {suggestion && preview.commonPrefix && (
          <div className="mt-[16px] flex flex-col gap-[10px] rounded-[var(--radius-card)] bg-[var(--color-wash)] p-[12px]">
            <span className="flex items-center gap-[8px]">
              <StatusDot status="accent" />
              <span className="text-heading text-[var(--color-ink)]">These paths look moved</span>
            </span>
            <span
              className="mono truncate text-[length:var(--text-mono)] text-[var(--color-ink)]"
              title={`${preview.commonPrefix} → ${suggestion.replacement}`}
            >
              {preview.commonPrefix} → {suggestion.replacement}
            </span>
            <span className="text-small text-[var(--color-ink-2)]">
              {plural(Math.max(0, suggestion.previewMatchCount - preview.matchedByPath), 'more track')} would be found.
            </span>
            <Button variant="secondary" className="self-start" disabled={busy} onClick={() => void applySuggestion(suggestion)}>
              Apply
            </Button>
          </div>
        )}
        <p className="mt-[14px] text-small text-[var(--color-ink-3)]">
          Anything still not found by path is tried by artist and title when you import.
        </p>
        {errorLine}
        <div className="mt-[14px] flex gap-[8px]">
          <Button variant="primary" disabled={busy} onClick={() => void commit()}>
            Import {plural(preview.totalEntries, 'track')}
          </Button>
          <Button variant="secondary" onClick={onBack}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <BackRow label="Collections" onBack={onBack} />
      <PanelHeader title="Import playlist" />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        disabled={busy}
        className={`mt-[14px] flex h-[180px] flex-col items-center justify-center gap-[8px] rounded-[16px] border-[1.5px] border-dashed text-center transition-colors duration-[var(--motion-fast)] ${
          dragging ? 'border-[var(--color-accent)] bg-[var(--color-wash-2)]' : 'border-[var(--color-line-strong)] bg-[var(--color-wash)]'
        }`}
      >
        <Icon name="add" size={22} className="text-[var(--color-ink-2)]" />
        <span className="text-heading text-[var(--color-ink)]">Drop an .m3u or .m3u8 file</span>
        <span className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
          or <span className="font-medium text-[var(--color-ink)]">choose a file</span>
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".m3u,.m3u8,audio/x-mpegurl,audio/mpegurl"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0]
          if (picked) void pick(picked)
          e.target.value = ''
        }}
      />
      {errorLine}
      <p className="mt-[12px] text-small [text-wrap:pretty] text-[var(--color-ink-3)]">
        Tracks are matched by file path first, then by artist and title. Nothing is added until you confirm.
      </p>
    </div>
  )
}
