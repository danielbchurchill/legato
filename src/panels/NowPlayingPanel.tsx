import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { CoverArt } from '../ui/CoverArt'
import { DataRow, SectionHeader } from '../ui/DataRow'
import { ArticleBody } from '../ui/ArticleBody'
import { Button } from '../ui/Button'
import type { PlaybackStatus, QueueEntry } from '../playback/usePlayback'

const API = 'http://127.0.0.1:8899/api/v1'

/* The right-hand panel's now-playing mode.
 *
 * Editable fields are exactly the ones the tag write-back API actually
 * supports (server/src/tagwrite/fields.ts): bpm, label, release type.
 * release_date is shown too — it lives in the file tags same as the other
 * three — but stays read-only, since TagLib# has no writable "release
 * date" property distinct from the numeric year and adding one wasn't in
 * scope here. Title/artist/album are display only in this pass; editing
 * those touches match/collapse identity, a different question from
 * fixing a wrong bpm.
 *
 * Pagination — the three dots — covers metadata, lyrics, and article.
 * Lyrics is fetched lazily (only once the lyrics page is actually opened,
 * not eagerly when a track starts) since GET /nodes/:id/lyrics is a real
 * network round trip to LRCLIB on a cache miss — see migration 0017's
 * comment on why that can't happen during a scan. */

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

type Edge = { direction: 'in' | 'out'; type: string; other_id: number; other_title: string }
type FileRow = {
  id: number
  bpm: number | null
  label: string | null
  release_date: string | null
  release_type: string | null
}
type NodeDetail = {
  id: number
  title: string
  recording: { canonical_duration_ms: number | null } | null
  files: FileRow[]
  edges: Edge[]
  article: { body_md: string } | null
}
type FieldDiff = { field: string; oldValue: string | number; newValue: string | number }
type TagWriteRow = { id: number; status: string; diff_json: string }
type LyricsData = { plainLyrics: string | null; syncedLyrics: string | null; instrumental: boolean; found: boolean }

type EditableFields = { bpm?: number; label?: string; releaseType?: string }

type NowPlayingPanelProps = {
  nodeId: number | null
  status: PlaybackStatus
  upNext: QueueEntry[]
  onSelectNode: (id: number) => void
}

export function NowPlayingPanel({ nodeId, status, upNext, onSelectNode }: NowPlayingPanelProps) {
  const [node, setNode] = useState<NodeDetail | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditableFields>({})
  const [pendingWrite, setPendingWrite] = useState<{ id: number; diff: FieldDiff[] } | null>(null)
  const [upNextOpen, setUpNextOpen] = useState(false)
  const [page, setPage] = useState(0)
  const [lyrics, setLyrics] = useState<LyricsData | 'loading' | null>(null)
  const swipeStartX = useRef<number | null>(null)

  const loadNode = (id: number) => {
    fetch(`${API}/nodes/${id}`)
      .then((r) => r.json())
      .then(setNode)
      .catch(() => setNode(null))
  }

  useEffect(() => {
    setEditing(false)
    setPendingWrite(null)
    setPage(0)
    setLyrics(null)
    if (nodeId == null) {
      setNode(null)
      return
    }
    loadNode(nodeId)
  }, [nodeId])

  const pages: Array<'metadata' | 'lyrics' | 'article'> = node
    ? node.article
      ? ['metadata', 'lyrics', 'article']
      : ['metadata', 'lyrics']
    : ['metadata']

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (editing) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(0, p - 1))
      if (e.key === 'ArrowRight') setPage((p) => Math.min(pages.length - 1, p + 1))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, pages.length])

  useEffect(() => {
    if (!node || pages[page] !== 'lyrics' || lyrics !== null) return
    setLyrics('loading')
    fetch(`${API}/nodes/${node.id}/lyrics`)
      .then((r) => (r.ok ? (r.json() as Promise<LyricsData>) : null))
      .then(setLyrics)
      .catch(() => setLyrics(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id, page, lyrics])

  if (nodeId == null || !node) {
    return (
      <p className="pt-[40px] text-center text-[length:var(--text-base)] text-[var(--color-muted)]">
        nothing playing
      </p>
    )
  }

  const file = node.files[0] as FileRow | undefined
  const artist = node.edges.find((e) => e.direction === 'out' && e.type === 'performed_by')
  const album = node.edges.find((e) => e.direction === 'out' && e.type === 'appears_on')

  const startEditing = () => {
    setDraft({
      bpm: file?.bpm ?? undefined,
      label: file?.label ?? undefined,
      releaseType: file?.release_type ?? undefined,
    })
    setEditing(true)
  }

  // Mandatory dry-run diff, per Legato.md's write-back spec — this only
  // ever computes and stores a diff for review, never writes to disk.
  const submitDraft = async () => {
    if (!file) return
    const res = await fetch(`${API}/tag-writes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: file.id, changes: draft }),
    })
    const data = (await res.json()) as (TagWriteRow & { diff_json: string }) | { noop: true }
    setEditing(false)
    if ('noop' in data) return // on-disk already matches — nothing to review
    setPendingWrite({ id: data.id, diff: JSON.parse(data.diff_json) as FieldDiff[] })
  }

  const approveWrite = async () => {
    if (!pendingWrite) return
    await fetch(`${API}/tag-writes/${pendingWrite.id}/approve`, { method: 'POST' })
    setPendingWrite(null)
    loadNode(node.id)
  }

  const discardWrite = async () => {
    if (!pendingWrite) return
    await fetch(`${API}/tag-writes/${pendingWrite.id}`, { method: 'DELETE' })
    setPendingWrite(null)
  }

  const handleSwipeStart = (e: React.PointerEvent) => {
    swipeStartX.current = e.clientX
  }
  const handleSwipeEnd = (e: React.PointerEvent) => {
    if (swipeStartX.current == null) return
    const delta = e.clientX - swipeStartX.current
    swipeStartX.current = null
    if (Math.abs(delta) < 40) return
    if (delta < 0) setPage((p) => Math.min(pages.length - 1, p + 1))
    else setPage((p) => Math.max(0, p - 1))
  }

  return (
    <div className="flex flex-col">
      <CoverArt
        nodeId={node.id}
        size="full"
        alt={`Cover art for ${node.title}`}
        className="aspect-square w-full"
      />

      <div className="mt-[12px] flex items-start justify-between gap-[8px]">
        <div className="min-w-0">
          <p className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
            {node.title}
          </p>
          {(artist || album) && (
            <p className="truncate text-[length:var(--text-base)] text-[var(--color-muted)]">
              {artist?.other_title}
              {artist && album ? ' — ' : ''}
              {album?.other_title}
            </p>
          )}
        </div>
        {upNext.length > 0 && (
          <button
            type="button"
            onClick={() => setUpNextOpen((v) => !v)}
            aria-label={upNextOpen ? 'Hide up next' : 'Show up next'}
            aria-expanded={upNextOpen}
            className={`shrink-0 text-[var(--color-muted)] transition-transform duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:text-[var(--color-muted-hi)] ${
              upNextOpen ? 'rotate-180' : ''
            }`}
          >
            <Icon name="chevron-down" size={24} />
          </button>
        )}
      </div>

      {upNextOpen && upNext.length > 0 && (
        <>
          <SectionHeader title="up next" />
          <ul className="mt-[8px] flex flex-col">
            {upNext.map((entry) => (
              <li key={entry.recordingNodeId}>
                <button
                  type="button"
                  onClick={() => onSelectNode(entry.recordingNodeId)}
                  className="w-full truncate py-[4px] text-left font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                >
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {pages.length > 1 && (
        <div className="mt-[15px] flex justify-center gap-[6px]">
          {pages.map((p, i) => (
            <button
              key={p}
              type="button"
              aria-label={`Page ${i + 1} of ${pages.length}: ${p}`}
              aria-current={i === page}
              onClick={() => setPage(i)}
              className={`h-[6px] w-[6px] rounded-full transition-colors duration-150 ${
                i === page ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-hairline)]'
              }`}
            />
          ))}
        </div>
      )}

      <div onPointerDown={handleSwipeStart} onPointerUp={handleSwipeEnd}>
        {pages[page] === 'metadata' && (
          <>
            <SectionHeader
              title="metadata"
              action={
                !editing &&
                !pendingWrite && (
                  <button
                    type="button"
                    onClick={startEditing}
                    aria-label="Edit metadata"
                    title="Edit metadata"
                    className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
                  >
                    <Icon name="pencil" size={24} />
                  </button>
                )
              }
            />

            <div className="mt-[8px]">
              <DataRow label="length" value={formatDuration(node.recording?.canonical_duration_ms ?? null)} />
              <DataRow label="elapsed" value={formatDuration(status.positionMs)} />
              {editing ? (
                <>
                  <DataRow
                    label="bpm"
                    value={
                      <input
                        type="number"
                        value={draft.bpm ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, bpm: e.target.value ? Number(e.target.value) : undefined }))}
                        className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none"
                      />
                    }
                  />
                  <DataRow
                    label="label"
                    value={
                      <input
                        type="text"
                        value={draft.label ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                        className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none"
                      />
                    }
                  />
                  <DataRow
                    label="release type"
                    value={
                      <input
                        type="text"
                        value={draft.releaseType ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, releaseType: e.target.value }))}
                        className="w-full bg-transparent font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)] outline-none"
                      />
                    }
                  />
                  <div className="flex gap-[16px] pt-[10px]">
                    <Button onClick={submitDraft}>review changes</Button>
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]"
                    >
                      cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {file?.bpm != null && <DataRow label="bpm" value={file.bpm} />}
                  {file?.label && <DataRow label="label" value={file.label} />}
                  {file?.release_date && <DataRow label="release date" value={file.release_date} />}
                  {file?.release_type && <DataRow label="release type" value={file.release_type} />}
                </>
              )}
            </div>

            {pendingWrite && (
              <>
                <SectionHeader title="review diff" />
                <ul className="mt-[8px] flex flex-col gap-[2px]">
                  {pendingWrite.diff.map((d) => (
                    <li
                      key={d.field}
                      className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-muted)]"
                    >
                      {d.field}: {String(d.oldValue)} → <span className="text-[var(--color-ink)]">{String(d.newValue)}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-[16px] pt-[10px]">
                  <Button variant="destructive" onClick={approveWrite}>
                    approve — write to file
                  </Button>
                  <button
                    type="button"
                    onClick={discardWrite}
                    className="text-[length:var(--text-base)] text-[var(--color-muted)] hover:text-[var(--color-muted-hi)]"
                  >
                    discard
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {pages[page] === 'lyrics' && (
          <>
            <SectionHeader title="lyrics" />
            {lyrics === null || lyrics === 'loading' ? (
              <p className="mt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">loading lyrics…</p>
            ) : !lyrics.found ? (
              <p className="mt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">no lyrics found</p>
            ) : lyrics.instrumental ? (
              <p className="mt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">instrumental</p>
            ) : (
              <pre className="mt-[8px] whitespace-pre-wrap text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink)]">
                {lyrics.plainLyrics}
              </pre>
            )}
          </>
        )}

        {pages[page] === 'article' && node.article && (
          <>
            <SectionHeader title="article" />
            <ArticleBody
              bodyMd={node.article.body_md}
              onSelectNode={onSelectNode}
              className="mt-[8px] text-[length:var(--text-base)] leading-relaxed text-[var(--color-ink)]"
            />
          </>
        )}
      </div>
    </div>
  )
}
