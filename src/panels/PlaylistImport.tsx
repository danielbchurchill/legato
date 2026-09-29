import { useState } from 'react'
import { Button } from '../ui/Button'
import { DataRow, SectionHeader } from '../ui/DataRow'
import { Disclosure } from '../ui/Disclosure'
import { API_BASE as API } from '../config/serverHost'

/* #124: M3U/M3U8 import. Reads the file with the browser's own File API
 * (readable even inside the Tauri webview — no Rust IPC needed for a plain
 * text read) and posts its raw text to the server, which owns every real
 * decision: parsing, path matching, the remap preview, and the metadata
 * fallback (server/src/routes/playlist-import.ts, server/src/routes/
 * m3u-parse.ts). This file is presentation over that API, same division of
 * labor as every other panel.
 *
 * Three phases, one component, matching Playlists.tsx's own
 * list/detail-in-one-file precedent: pick a file, review the path-match
 * preview (and optionally apply a remap suggestion), then the persisted
 * report. `ImportReportView` is exported separately so PlaylistDetail can
 * reuse it for a report fetched later via GET /playlists/:id/import-report
 * — the "report stays viewable" done-when item isn't just this flow's own
 * last screen. */

export type PathRemap = { from: string; to: string }

export type PrefixSuggestion = {
  libraryRootId: number
  libraryRootPath: string
  replacement: string
  previewMatchCount: number
}

type ImportPreview = {
  totalEntries: number
  matchedByPath: number
  unmatchedByPath: number
  commonPrefix: string | null
  suggestions: PrefixSuggestion[]
}

export type ImportEntryResult = {
  position: number
  rawPath: string
  extinfArtist: string | null
  extinfTitle: string | null
  extinfDurationSeconds: number | null
  matchType: 'path' | 'metadata' | 'missing'
  matchedNodeId: number | null
  reason: string | null
}

type ImportResult = {
  importId: number
  playlist: { id: number; name: string }
  entries: ImportEntryResult[]
}

async function fetchPreview(content: string, remap: PathRemap | null): Promise<ImportPreview> {
  const res = await fetch(`${API}/playlists/import/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, remap }),
  })
  if (!res.ok) throw new Error('preview failed')
  return res.json()
}

/* The report's own view: counts plus the missing list, behind a
 * disclosure so a long playlist's misses don't force-scroll the summary
 * out of view. Shared between "just imported" (entries carry a fresh
 * ImportResult) and "viewing an old report" (entries came back from
 * GET /playlists/:id/import-report) — both hand it the same entry shape. */
export function ImportReportView({ sourceFilename, entries }: { sourceFilename: string; entries: ImportEntryResult[] }) {
  const matchedByPath = entries.filter((e) => e.matchType === 'path').length
  const matchedByMetadata = entries.filter((e) => e.matchType === 'metadata').length
  const missing = entries.filter((e) => e.matchType === 'missing')

  return (
    <div>
      <SectionHeader title="import report" />
      <DataRow label="source file" value={sourceFilename} />
      <DataRow label="matched by path" value={matchedByPath} truncate={false} />
      <DataRow label="matched by metadata" value={matchedByMetadata} truncate={false} />
      <DataRow label="missing" value={missing.length} truncate={false} />

      {missing.length > 0 && (
        <div className="pt-[16px]">
          <Disclosure title={`missing tracks (${missing.length})`}>
            <div>
              {missing.map((entry) => (
                <div key={entry.position} className="border-b border-[var(--color-divider)] py-[10px] last:border-b-0">
                  <p className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
                    {entry.extinfArtist && entry.extinfTitle ? `${entry.extinfArtist} — ${entry.extinfTitle}` : entry.rawPath}
                  </p>
                  <p className="truncate text-[length:var(--text-base)] text-[var(--color-muted)]">{entry.reason}</p>
                </div>
              ))}
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  )
}

export function PlaylistImport({
  onImported,
  onCancel,
}: {
  onImported: (playlist: { id: number; name: string }) => void
  onCancel: () => void
}) {
  const [filename, setFilename] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [remap, setRemap] = useState<PathRemap | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  const pickFile = async (file: File) => {
    setError(null)
    setBusy(true)
    try {
      const text = await file.text()
      const nextPreview = await fetchPreview(text, null)
      setFilename(file.name)
      setContent(text)
      setPreview(nextPreview)
      setRemap(null)
    } catch {
      setError("Couldn't read that file — make sure it's a .m3u or .m3u8 playlist.")
    } finally {
      setBusy(false)
    }
  }

  const applySuggestion = async (suggestion: PrefixSuggestion) => {
    if (!content || !preview?.commonPrefix) return
    const candidate: PathRemap = { from: preview.commonPrefix, to: suggestion.replacement }
    setBusy(true)
    setError(null)
    try {
      setPreview(await fetchPreview(content, candidate))
      setRemap(candidate)
    } catch {
      setError('Could not re-check that remap — try again.')
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!filename || !content) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API}/playlists/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content, remap }),
      })
      if (!res.ok) throw new Error()
      setResult((await res.json()) as ImportResult)
    } catch {
      setError('Import failed — try again.')
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    return (
      <div>
        <ImportReportView sourceFilename={filename ?? ''} entries={result.entries} />
        <div className="pt-[24px]">
          <Button onClick={() => onImported(result.playlist)}>open playlist →</Button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={onCancel}
        className="mb-[15px] text-[length:var(--text-base)] text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
      >
        ← playlists
      </button>

      <SectionHeader title="import m3u / m3u8" />

      {!preview ? (
        <div className="pt-[16px]">
          <label className="inline-block cursor-pointer text-[length:var(--text-base)] text-[var(--color-ink)] transition-colors duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)]">
            choose a playlist file…
            <input
              type="file"
              accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void pickFile(file)
                e.target.value = ''
              }}
            />
          </label>
          {busy && <p className="pt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">reading…</p>}
        </div>
      ) : (
        <div className="pt-[16px]">
          <DataRow label="file" value={filename ?? ''} />
          <DataRow label="tracks" value={preview.totalEntries} truncate={false} />
          <DataRow label="matched by path" value={preview.matchedByPath} truncate={false} />
          <DataRow label="unmatched" value={preview.unmatchedByPath} truncate={false} />

          {preview.unmatchedByPath > 0 && preview.commonPrefix && (
            <div className="pt-[16px]">
              {preview.suggestions.length > 0 ? (
                <>
                  <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
                    {remap ? 'remap applied — preview updated above:' : 'suggested path remap:'}
                  </p>
                  {preview.suggestions.map((suggestion) => {
                    const applied = remap?.to === suggestion.replacement && remap?.from === preview.commonPrefix
                    return (
                      <div
                        key={`${suggestion.libraryRootId}-${suggestion.replacement}`}
                        className="flex items-center justify-between gap-[12px] border-b border-[var(--color-divider)] py-[10px] last:border-b-0"
                      >
                        <span className="min-w-0 truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
                          {preview.commonPrefix} → {suggestion.replacement}
                        </span>
                        <div className="flex shrink-0 items-center gap-[12px]">
                          <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">
                            +{suggestion.previewMatchCount}
                          </span>
                          <Button onClick={() => void applySuggestion(suggestion)} disabled={busy || applied}>
                            {applied ? 'applied' : 'apply'}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </>
              ) : (
                <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">
                  No library folder matches the unmatched tracks' paths — they may fall back to a metadata match, or be
                  reported as missing.
                </p>
              )}
            </div>
          )}

          <div className="mt-[24px] flex items-center gap-[16px]">
            <Button onClick={() => void commit()} disabled={busy}>
              import
            </Button>
            <Button onClick={onCancel} disabled={busy}>
              cancel
            </Button>
          </div>
        </div>
      )}

      {error && <p className="pt-[16px] text-[length:var(--text-base)] text-[var(--color-muted)]">{error}</p>}
    </div>
  )
}
