import { useEffect, useState } from 'react'
import { SortPill } from '../library/SortPill'
import type { SortKind } from '../library/types'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { Shimmer } from '../ui/Skeleton'
import { TextField } from '../ui/TextField'
import { useTouchLayout } from '../ui/touchLayout'
import { formatCount, NO_VALUE, plural } from '../ui/format'
import { API_BASE as API } from '../config/serverHost'
import { albumLinks, picardNote } from './gapLinks'
import {
  approveWrites,
  changesFor,
  discardWrites,
  GAP_WRITE,
  InvalidValue,
  parseValues,
  proposeWrites,
  summarize,
  type Proposal,
} from './gapWrites'
import {
  ALBUM_FILL_FIELDS,
  GAP_FIELDS,
  useGapAlbums,
  useGapCounts,
  useGapRevision,
  useGapTracks,
  type GapAlbum,
  type GapField,
  type GapFile,
  type GapSort,
  type GapTrack,
  type GapView,
} from './healthData'
import { Heading, Quiet } from './worklistParts'

/* Library health's metadata gaps (#469): the albums whose tracks are
 * missing a tag the map and the library use, a page at a time, each
 * opening to its tracks, a value for the whole album, and where to look the
 * values up. Filtered by kind of gap (the chips, BPM off by default) and by
 * artist, and sorted by artist, album, number of gaps or plays. Nothing is
 * written to a file from here without a review: a value becomes tag writes,
 * the same dry run the details panel's edit makes. */

const SORT_OPTIONS: { id: GapSort; label: string; firstDir?: 'asc' | 'desc' }[] = [
  { id: 'gaps', label: 'gaps', firstDir: 'desc' },
  { id: 'plays', label: 'plays', firstDir: 'desc' },
  { id: 'artist', label: 'artist' },
  { id: 'album', label: 'album' },
]
const SORT_KIND: Record<GapSort, SortKind> = { gaps: 'count', plays: 'count', artist: 'text', album: 'text' }

const chipOf = (field: GapField) => GAP_FIELDS.find((g) => g.field === field)!.chip
/* What a gap says on a track or in an album's breakdown: "no label". */
const gapWords = (field: GapField) => (field === 'unmatched' ? 'unmatched' : `no ${chipOf(field)}`)

// A tag write's field, as the chips name it.
const FIELD_WORDS: Record<string, string> = { label: 'label', releaseDate: 'release date', releaseType: 'type', bpm: 'bpm' }

// How long the artist search waits after the last key before it asks.
const SEARCH_DEBOUNCE_MS = 250

type MetadataGapsProps = {
  view: GapView
  onViewChange: (view: GapView) => void
  onFocusNode: (id: number) => void
}

export function MetadataGaps({ view, onViewChange, onFocusNode }: MetadataGapsProps) {
  const touch = useTouchLayout()
  const revision = useGapRevision()
  const counts = useGapCounts(view.artist, revision)
  const albums = useGapAlbums(view, revision)
  const [search, setSearch] = useState(view.artist)
  const [open, setOpen] = useState<Set<string>>(new Set())

  // The search box answers as you type, but asks the server only once the
  // typing pauses.
  useEffect(() => {
    if (search === view.artist) return
    const timer = setTimeout(() => onViewChange({ ...view, artist: search }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search, view, onViewChange])

  const toggleKind = (field: GapField) => {
    const kinds = view.kinds.includes(field) ? view.kinds.filter((k) => k !== field) : [...view.kinds, field]
    onViewChange({ ...view, kinds: GAP_FIELDS.map((g) => g.field).filter((f) => kinds.includes(f)) })
  }
  const toggleAlbum = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <>
      <Heading title="Metadata gaps" count={albums.total}>
        Albums with tracks missing a tag the map and the library use. A value you add is proposed as a tag write, and no file changes until
        you write it.
      </Heading>
      {/* Rows of chips far enough apart that their 44px targets don't
       * overlap, in the phone's touch layout. */}
      <div role="group" aria-label="Kinds of gap" className={`flex flex-wrap ${touch ? 'gap-x-[6px] gap-y-[16px]' : 'gap-[6px]'}`}>
        {GAP_FIELDS.map((gap) => (
          <Chip
            key={gap.field}
            active={view.kinds.includes(gap.field)}
            count={counts ? formatCount(counts[gap.field]) : undefined}
            onClick={() => toggleKind(gap.field)}
          >
            {gap.chip}
          </Chip>
        ))}
      </div>
      <div className={`flex items-center gap-[8px] ${touch ? 'mt-[18px]' : 'mt-[10px]'}`}>
        <TextField prose label="Filter by artist" placeholder="artist" value={search} onChange={setSearch} className="flex-1" />
        <SortPill
          options={SORT_OPTIONS}
          value={view.sort}
          dir={view.dir}
          kindOf={(id) => SORT_KIND[id]}
          onChange={(sort, dir) => onViewChange({ ...view, sort, dir })}
          large={touch}
        />
      </div>

      <ul className="-mx-[8px] mt-[10px] flex flex-col">
        {(albums.items ?? []).map((album) => {
          const key = String(album.id ?? 'none')
          return (
            <AlbumGaps
              key={key}
              album={album}
              view={view}
              revision={revision}
              open={open.has(key)}
              onToggle={() => toggleAlbum(key)}
              onFocusNode={onFocusNode}
            />
          )
        })}
      </ul>
      {albums.items && albums.total != null && albums.items.length < albums.total && (
        <div className="mt-[10px] flex items-center gap-[10px]">
          <Button variant="secondary" onClick={albums.more} disabled={albums.loadingMore}>
            {albums.loadingMore ? <Shimmer>Loading…</Shimmer> : 'Show more albums'}
          </Button>
          <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">
            {formatCount(albums.items.length)} of {formatCount(albums.total)}
          </span>
        </div>
      )}
      {view.kinds.length === 0 ? (
        <Quiet>Pick a kind of gap to list.</Quiet>
      ) : (
        albums.items &&
        albums.items.length === 0 && (
          <Quiet>{view.artist.trim() ? `Nothing missing for artists matching “${view.artist.trim()}”.` : 'Nothing missing here.'}</Quiet>
        )
      )}
    </>
  )
}

/* ---- An album --------------------------------------------------------------- */

function AlbumGaps({
  album,
  view,
  revision,
  open,
  onToggle,
  onFocusNode,
}: {
  album: GapAlbum
  view: GapView
  revision: number
  open: boolean
  onToggle: () => void
  onFocusNode: (id: number) => void
}) {
  const touch = useTouchLayout()
  const title = album.title ?? 'No album'
  const detail = [
    album.id == null ? 'tracks with no album tag' : (album.artist ?? NO_VALUE),
    album.plays > 0 ? plural(album.plays, 'play') : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className={`flex flex-col rounded-[var(--radius-control)] px-[8px] ${open ? 'bg-[var(--color-wash)] pb-[12px]' : ''}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        title={`${plural(album.gaps, 'gap')} on ${plural(album.tracks, 'track')}`}
        className={`flex ${touch ? 'min-h-[60px]' : 'h-[52px]'} w-full items-center gap-[10px] text-left`}
      >
        {album.id != null ? (
          <CoverArt nodeId={album.id} size="thumb" radius="sm" className="size-[36px] shrink-0" />
        ) : (
          <span aria-hidden="true" className="size-[36px] shrink-0 rounded-[var(--radius-art-sm)] bg-[var(--color-placeholder)]" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span title={title} className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
            {title}
          </span>
          <span title={detail} className="truncate text-small text-[var(--color-ink-2)]">
            {detail}
          </span>
        </span>
        <span className="mono shrink-0 text-[length:var(--text-mono)] text-[var(--color-ink)]">{formatCount(album.gaps)}</span>
        <span
          className={`inline-flex shrink-0 text-[var(--color-ink-3)] transition-transform duration-[var(--motion-fast)] ${open ? '' : '-rotate-90'}`}
        >
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
      {open && <AlbumDetail album={album} view={view} revision={revision} onFocusNode={onFocusNode} />}
    </li>
  )
}

function AlbumDetail({
  album,
  view,
  revision,
  onFocusNode,
}: {
  album: GapAlbum
  view: GapView
  revision: number
  onFocusNode: (id: number) => void
}) {
  const tracks = useGapTracks(album.id, view, revision)
  const breakdown = view.kinds.filter((k) => (album.byKind[k] ?? 0) > 0)
  // A value for the whole album, for the album-level fields this album
  // lacks and the list is showing. The tracks with no album aren't an
  // album, so they're filled one by one.
  const fillable = album.id != null ? ALBUM_FILL_FIELDS.filter((f) => view.kinds.includes(f) && (album.byKind[f] ?? 0) > 0) : []
  return (
    <div className="flex flex-col gap-[12px] pt-[2px]">
      {breakdown.length > 0 && (
        <p className="flex flex-wrap gap-x-[12px] gap-y-[2px] text-small text-[var(--color-ink-2)]">
          {breakdown.map((k) => (
            <span key={k}>
              {gapWords(k)} <span className="mono text-[var(--color-ink)]">{formatCount(album.byKind[k] ?? 0)}</span>
            </span>
          ))}
        </p>
      )}
      {album.id != null && fillable.length > 0 && <AlbumFill albumId={album.id} fields={fillable} />}
      {album.id != null && album.title && (
        <FindLinks album={{ title: album.title, artist: album.artist, releaseMbid: album.releaseMbid }} />
      )}
      <ul className="flex flex-col">
        {(tracks.items ?? []).map((track) => (
          <TrackGaps key={track.id} track={track} view={view} onFocusNode={onFocusNode} />
        ))}
      </ul>
      {tracks.items && tracks.total != null && tracks.items.length < tracks.total && (
        <Button className="self-start" onClick={tracks.more} disabled={tracks.loadingMore}>
          {tracks.loadingMore ? 'loading…' : `show more tracks (${formatCount(tracks.total - tracks.items.length)})`}
        </Button>
      )}
    </div>
  )
}

/* ---- Where to find it ------------------------------------------------------- */

function FindLinks({ album }: { album: { title: string; artist: string | null; releaseMbid: string | null } }) {
  const touch = useTouchLayout()
  const links = albumLinks(album, { localPicard: !touch })
  const link = `text-[length:var(--text-secondary)] font-medium text-[var(--color-ink-2)] transition-colors duration-[var(--motion-fast)] hover:text-[var(--color-ink)] ${
    touch ? 'inline-flex h-[44px] items-center' : ''
  }`
  return (
    <div className="flex flex-col gap-[4px]">
      <span className="text-label text-[var(--color-ink-2)]">look it up</span>
      <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[2px]">
        {[links.musicbrainz, links.discogs, links.picard].map((l) => (
          <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className={link}>
            {l.label}
          </a>
        ))}
      </div>
      <p className="text-small [text-wrap:pretty] text-[var(--color-ink-3)]">
        {picardNote({ opensRelease: links.picard.opensRelease, localPicard: !touch })}
      </p>
    </div>
  )
}

/* ---- A value for the whole album -------------------------------------------- */

type FillPhase =
  | { step: 'edit'; problem: string | null }
  | { step: 'preparing' }
  | { step: 'review'; proposal: Proposal }
  | { step: 'writing'; proposal: Proposal; done: number }
  | { step: 'written'; written: number; failed: { id: number; error: string }[] }

function AlbumFill({ albumId, fields }: { albumId: number; fields: GapField[] }) {
  const [text, setText] = useState<Partial<Record<GapField, string>>>({})
  const [phase, setPhase] = useState<FillPhase>({ step: 'edit', problem: null })

  const review = async () => {
    let values: ReturnType<typeof parseValues>
    try {
      values = parseValues(Object.fromEntries(fields.map((f) => [f, text[f] ?? ''])))
    } catch (err) {
      if (err instanceof InvalidValue) setPhase({ step: 'edit', problem: `That doesn't look like a ${chipOf(err.field)}.` })
      return
    }
    setPhase({ step: 'preparing' })
    try {
      const files = (await fetch(`${API}/tag-manager/albums/${albumId}/files`).then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.json()
      })) as GapFile[]
      const targets = files.flatMap((f) => {
        const changes = changesFor(f.missing, values)
        return changes ? [{ fileId: f.id, changes }] : []
      })
      const proposal = await proposeWrites(targets)
      setPhase({ step: 'review', proposal })
    } catch {
      setPhase({ step: 'edit', problem: "Couldn't reach the Legato server." })
    }
  }

  const write = async (proposal: Proposal) => {
    setPhase({ step: 'writing', proposal, done: 0 })
    const result = await approveWrites(
      proposal.proposed.map((p) => p.id),
      (done) => setPhase({ step: 'writing', proposal, done }),
    )
    setPhase({ step: 'written', ...result })
  }

  const discard = async (proposal: Proposal) => {
    await discardWrites(proposal.proposed.map((p) => p.id))
    setPhase({ step: 'edit', problem: null })
  }

  if (phase.step === 'review' || phase.step === 'writing') {
    const { proposal } = phase
    const files = proposal.proposed.length
    return (
      <div className="flex flex-col gap-[8px] rounded-[var(--radius-control)] border border-[var(--color-line)] p-[10px]">
        <span className="text-label text-[var(--color-ink-2)]">review</span>
        {files > 0 ? (
          <ul className="flex flex-col gap-[2px]">
            {summarize(proposal.proposed).map((line) => (
              <li
                key={`${line.field}:${line.value}`}
                className="flex min-w-0 flex-wrap items-baseline gap-x-[6px] text-[length:var(--text-secondary)] leading-[18px]"
              >
                <span className="text-[var(--color-ink-2)]">{FIELD_WORDS[line.field] ?? line.field}</span>
                <span aria-hidden="true" className="text-[var(--color-ink-3)]">
                  ›
                </span>
                <span className="mono text-[length:var(--text-mono)] [overflow-wrap:anywhere] text-[var(--color-ink)]">{line.value}</span>
                <span className="text-[var(--color-ink-2)]">on {plural(line.files, 'file')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">Nothing to write: the files already say that.</p>
        )}
        {proposal.unchanged > 0 && (
          <p className="text-small text-[var(--color-ink-2)]">{plural(proposal.unchanged, 'file')} already had it on disk.</p>
        )}
        {proposal.failed.length > 0 && (
          <p className="text-small [overflow-wrap:anywhere] text-[var(--color-bad)]">
            {plural(proposal.failed.length, 'file')} can't take it: {proposal.failed[0]!.error}
          </p>
        )}
        {phase.step === 'writing' ? (
          <Shimmer className="text-[length:var(--text-secondary)] text-[var(--color-ink)]">
            {`Writing ${formatCount(phase.done)} of ${formatCount(files)}…`}
          </Shimmer>
        ) : (
          <div className="flex flex-wrap gap-[8px]">
            {files > 0 && (
              <Button variant="primary" onClick={() => void write(proposal)}>
                Write to {plural(files, 'file')}
              </Button>
            )}
            <Button variant="secondary" onClick={() => void discard(proposal)}>
              {files > 0 ? 'Discard' : 'Back'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (phase.step === 'written') {
    return (
      <div className="flex flex-col gap-[4px]">
        <p className="text-[length:var(--text-secondary)] text-[var(--color-ink)]">
          Written to {plural(phase.written, 'file')}.{phase.written > 0 ? ' Revert any of them under Tag writes.' : ''}
        </p>
        {phase.failed.length > 0 && (
          <p className="text-small [overflow-wrap:anywhere] text-[var(--color-bad)]">
            {plural(phase.failed.length, 'file')} couldn't be written: {phase.failed[0]!.error}
          </p>
        )}
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-[8px]"
      onSubmit={(e) => {
        e.preventDefault()
        void review()
      }}
    >
      <span className="text-small text-[var(--color-ink-2)]">For every track on this album that's missing it:</span>
      {fields.map((field) => (
        <label key={field} className="flex items-center gap-[10px]">
          <span className="w-[84px] shrink-0 text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">{chipOf(field)}</span>
          <TextField
            label={`${chipOf(field)} for the album`}
            placeholder={GAP_WRITE[field]!.hint}
            value={text[field] ?? ''}
            onChange={(value) => setText((prev) => ({ ...prev, [field]: value }))}
            className="flex-1"
          />
        </label>
      ))}
      {phase.step === 'edit' && phase.problem && <p className="text-small text-[var(--color-bad)]">{phase.problem}</p>}
      <Button
        variant="primary"
        type="submit"
        className="self-start"
        disabled={phase.step === 'preparing' || fields.every((f) => !(text[f] ?? '').trim())}
      >
        {phase.step === 'preparing' ? <Shimmer>Preparing…</Shimmer> : 'Review changes'}
      </Button>
    </form>
  )
}

/* ---- A track ------------------------------------------------------------------ */

function TrackGaps({ track, view, onFocusNode }: { track: GapTrack; view: GapView; onFocusNode: (id: number) => void }) {
  const touch = useTouchLayout()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState<Partial<Record<GapField, string>>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [queued, setQueued] = useState(false)
  const [rescanned, setRescanned] = useState(false)
  // The fields this track can take a value for: missing on one of its
  // files, and one the list is showing.
  const fields = GAP_FIELDS.map((g) => g.field).filter(
    (f) => GAP_WRITE[f] && view.kinds.includes(f) && track.files.some((file) => file.missing.includes(f)),
  )
  const missing = track.missing.map(gapWords).join(' · ')

  // Filling a gap proposes a tag write per file that lacks it; the file
  // changes only once that write is approved under Tag writes.
  const save = async () => {
    let values: ReturnType<typeof parseValues>
    try {
      values = parseValues(text)
    } catch (err) {
      if (err instanceof InvalidValue) setProblem(`That doesn't look like a ${chipOf(err.field)}.`)
      return
    }
    const targets = track.files.flatMap((f) => {
      const changes = changesFor(f.missing, values)
      return changes ? [{ fileId: f.id, changes }] : []
    })
    const proposal = await proposeWrites(targets)
    if (proposal.failed.length > 0) {
      setProblem(proposal.failed[0]!.error)
      return
    }
    if (proposal.proposed.length === 0) {
      // The file already says it; Legato read it before the tag changed.
      setProblem('The file already has that. Rescan it to bring Legato up to date.')
      return
    }
    setQueued(true)
    setEditing(false)
    setProblem(null)
  }

  const rescan = async () => {
    setRescanned(true)
    await fetch(`${API}/nodes/${track.id}/rescan`, { method: 'POST' }).catch(() => undefined)
  }

  const number = track.trackNo != null ? `${track.discNo != null && track.discNo > 1 ? `${track.discNo}.` : ''}${track.trackNo}` : ''
  return (
    <li className={`flex flex-col ${editing ? 'pb-[10px]' : ''}`}>
      <div className={`flex ${touch ? 'min-h-[52px]' : 'min-h-[44px]'} items-center gap-[10px]`}>
        <span className="mono w-[22px] shrink-0 text-right text-[11px] text-[var(--color-ink-3)]">{number}</span>
        <button
          type="button"
          onClick={() => onFocusNode(track.id)}
          className={`flex min-w-0 flex-1 flex-col text-left ${touch ? 'touch-target' : ''}`}
        >
          <span
            title={track.title}
            className="truncate text-[length:var(--text-secondary)] leading-[18px] font-medium text-[var(--color-ink)]"
          >
            {track.title}
          </span>
          <span title={missing} className="truncate text-small text-[var(--color-ink-2)]">
            {missing}
          </span>
        </button>
        {queued ? (
          <span className="shrink-0 text-small text-[var(--color-ink-3)]">in Tag writes</span>
        ) : (
          <span className="flex shrink-0 gap-[12px]">
            {fields.length > 0 && !editing && (
              <Button
                onClick={() => {
                  setEditing(true)
                  setText({})
                  setProblem(null)
                }}
              >
                add
              </Button>
            )}
            <Button onClick={() => void rescan()} disabled={rescanned}>
              {rescanned ? 'rescanned' : 'rescan'}
            </Button>
          </span>
        )}
      </div>
      {editing && (
        <form
          className="flex flex-col gap-[8px] pl-[32px]"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          {fields.map((field, i) => (
            <label key={field} className="flex items-center gap-[10px]">
              <span className="w-[84px] shrink-0 text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">{chipOf(field)}</span>
              <TextField
                autoFocus={i === 0}
                label={chipOf(field)}
                placeholder={GAP_WRITE[field]!.hint}
                value={text[field] ?? ''}
                onChange={(value) => setText((prev) => ({ ...prev, [field]: value }))}
                onEscape={() => setEditing(false)}
                className="flex-1"
              />
            </label>
          ))}
          {problem && <p className="text-small [overflow-wrap:anywhere] text-[var(--color-bad)]">{problem}</p>}
          <div className="flex gap-[8px]">
            <Button variant="primary" type="submit" disabled={fields.every((f) => !(text[f] ?? '').trim())}>
              Save
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  )
}
