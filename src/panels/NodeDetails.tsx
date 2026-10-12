import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { SectionLabel } from '../ui/SectionLabel'
import { Skeleton } from '../ui/Skeleton'
import { StatusDot } from '../ui/StatusDot'
import { Tabs } from '../ui/Tabs'
import { TextField } from '../ui/TextField'
import { formatClock, formatCount, formatDuration, NO_VALUE, plural } from '../ui/format'
import { useGraph } from '../canvas/graphContext'
import type { DetailsTab } from '../shell/panels'
import type { usePlayback } from '../playback/usePlayback'
import { AddToPlaylistButton } from './AddToPlaylistButton'
import { DetailRows } from './DetailRows'
import { formatBitrate, formatFormat } from './format'
import { useFavourite } from './useFavourite'
import { API, type NodeDetail } from './useNodeDetail'
import { TYPE_WORD, useJson, useNodeDetails, type CreditedPerson, type Summary, type TracklistEntry } from './nodeDetailsData'
import { LABELS, useTagEdit, type EditableKey } from './useTagEdit'
import { formatWhen } from './healthData'

/* Node details, in the right-hand panel: everything about one artist,
 * record or track, without covering the map the way the old full-screen
 * inspector did. "details ›" on the map's card opens it; so does anything
 * opened from the library or a search.
 *
 * The overview leads with the cover; the other tabs — tracks, credits,
 * metadata — are reading and editing views, so they shrink the header to a
 * 96px cover and give the room to their content.
 *
 * The phone's node detail (#389, src/phone/PhoneNode.tsx) is the same
 * thing in its sheet: it reads the node through useNodeDetails and draws
 * these tabs with `sheet` set, inside the phone's touch layout
 * (ui/touchLayout.ts). There every button and chip takes taps across 44px;
 * `sheet` makes the rows the handoff's 44 and 60px, the few controls the
 * touch layout doesn't reach 44px, and every field 16px, where iOS doesn't
 * zoom to type in it. */

type Playback = ReturnType<typeof usePlayback>
const OVERVIEW_TRACKS = 5

function formatAdded(value: string | undefined): string {
  if (!value) return NO_VALUE
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? NO_VALUE : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type NodeDetailsProps = {
  nodeId: number
  tab: DetailsTab
  onTabChange: (tab: DetailsTab) => void
  playback: Playback
  onFocusNode: (id: number) => void
}

export function NodeDetails({ nodeId, tab, onTabChange, playback, onFocusNode }: NodeDetailsProps) {
  const details = useNodeDetails(nodeId, playback)
  if (!details) return <DetailsSkeleton />
  const { node, reload, summary, tracklist, credits, kindLine, artistName, artistId, tabs } = details

  return (
    <div className="flex flex-col">
      {tab === 'overview' ? (
        <>
          <CoverArt
            nodeId={node.id}
            size="full"
            radius={node.type === 'artist' ? 'round' : 'hero'}
            alt={`Cover art for ${node.title}`}
            className="aspect-square w-full shadow-[var(--shadow-panel)]"
          />
          <div className="mt-[16px] flex flex-col gap-[2px]">
            <span className="text-small text-[var(--color-ink-2)]">{kindLine}</span>
            <h2 className="text-[22px] leading-[28px] font-medium [overflow-wrap:anywhere] text-[var(--color-ink)]">{node.title}</h2>
            {artistName && <ArtistLink name={artistName} id={artistId} onFocusNode={onFocusNode} />}
          </div>
        </>
      ) : (
        <div className="flex items-end gap-[12px]">
          <CoverArt
            nodeId={node.id}
            size="thumb"
            radius={node.type === 'artist' ? 'round' : 'hero'}
            alt=""
            className="size-[96px] shadow-[var(--shadow-sm)]"
          />
          <div className="flex min-w-0 flex-col gap-[2px]">
            <span className="text-small text-[var(--color-ink-2)]">{kindLine}</span>
            <h2 className="line-clamp-2 text-[19px] leading-[24px] font-medium text-[var(--color-ink)]">{node.title}</h2>
            {artistName && <ArtistLink name={artistName} id={artistId} onFocusNode={onFocusNode} />}
          </div>
        </div>
      )}

      <div className="mt-[12px] flex items-center gap-[8px]">
        {details.canPlay && (
          <Button variant="primary" icon="play" onClick={details.play} disabled={playback.queueBusy}>
            play
          </Button>
        )}
        {details.canShuffle && (
          <Button variant="secondary" icon="arrow-swap" onClick={details.shuffle} disabled={playback.queueBusy}>
            shuffle
          </Button>
        )}
        <span className="ml-auto flex">
          <FavouriteButton node={node} />
          {node.type === 'recording' && <AddToPlaylistButton nodeId={node.id} />}
          {(node.type === 'recording' || node.type === 'release') && (
            <IconButton icon="pencil" label="Edit tags" active={tab === 'metadata'} onClick={() => onTabChange('metadata')} />
          )}
        </span>
      </div>

      <Tabs
        label="details"
        variant="underline"
        options={tabs}
        value={tab}
        onChange={onTabChange}
        className="mt-[16px] w-full border-b border-[var(--color-line)]"
      />

      {tab === 'overview' && (
        <Overview
          node={node}
          summary={summary}
          tracklist={tracklist}
          people={credits.people}
          onShowTracks={() => onTabChange('tracks')}
          playback={playback}
          onFocusNode={onFocusNode}
        />
      )}
      {tab === 'tracks' && <TracksTab node={node} tracklist={tracklist} playback={playback} onFocusNode={onFocusNode} />}
      {tab === 'credits' && <CreditsTab node={node} people={credits.people} reload={reload} onFocusNode={onFocusNode} />}
      {tab === 'metadata' && <MetadataTab key={node.id} node={node} summary={summary} reload={reload} />}
    </div>
  )
}

function ArtistLink({ name, id, onFocusNode }: { name: string; id: number | null; onFocusNode: (id: number) => void }) {
  return id != null ? (
    <button
      type="button"
      onClick={() => onFocusNode(id)}
      className="self-start truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)] hover:underline"
    >
      {name}
    </button>
  ) : (
    <span className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">{name}</span>
  )
}

export function FavouriteButton({ node, sheet = false }: { node: NodeDetail; sheet?: boolean }) {
  const [isFavourite, toggle] = useFavourite(node.id, node.is_favourite)
  return (
    <IconButton
      icon="heart"
      label={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
      filled={isFavourite}
      active={isFavourite}
      aria-pressed={isFavourite}
      onClick={toggle}
      // The sheet's ghost: 44px, the handoff's 21px glyph, no tooltip on
      // touch.
      {...(sheet ? { size: 44, iconSize: 21, tooltip: false } : {})}
    />
  )
}

/* In the phone's sheet, a track is the handoff's 44px row: the number in a
 * 20px column, the title at 15px, 12px apart. */
const SHEET_TRACK_ROW = 'h-[44px] grid-cols-[20px_minmax(0,1fr)_auto] gap-[12px] px-[4px]'
const SHEET_TRACK_TITLE = 'text-[15px] leading-[20px]'

function Section({
  label,
  action,
  children,
  className = 'mt-[18px]',
}: {
  label: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className}>
      <SectionLabel action={action} className="h-[24px]">
        {label}
      </SectionLabel>
      {children}
    </section>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[2px]">
      <dd className="truncate text-[18px] leading-[24px] font-medium tabular-nums text-[var(--color-ink)]">{value}</dd>
      <dt className="order-last text-small text-[var(--color-ink-2)]">{label}</dt>
    </div>
  )
}

/* ---- Overview ------------------------------------------------------------- */

export function Overview({
  node,
  summary,
  tracklist,
  people,
  onShowTracks,
  playback,
  onFocusNode,
  sheet = false,
}: {
  node: NodeDetail
  summary: Summary | null
  tracklist: TracklistEntry[] | null
  people: CreditedPerson[]
  onShowTracks: () => void
  playback: Playback
  onFocusNode: (id: number) => void
  sheet?: boolean
}) {
  // The phone's sheet lists a producer's or engineer's tracks, as it does a
  // record's (nodeDetailsData.ts).
  const listsTracks = node.type === 'release' || (sheet && node.type === 'credit')
  // Plays are counted per track; a record or an artist shows its size instead.
  const stats: [string, string][] =
    node.type === 'recording'
      ? [
          [formatCount(node.playCount ?? 0), 'plays'],
          [formatDuration(node.recording?.canonical_duration_ms), 'length'],
          [formatAdded(node.created_at), 'added'],
        ]
      : summary?.kind === 'release'
        ? [
            [formatCount(summary.tracks), 'tracks'],
            [formatClock(summary.totalDurationMs), 'length'],
            [formatAdded(node.created_at), 'added'],
          ]
        : summary?.kind === 'artist'
          ? [
              [formatCount(summary.releases), 'albums'],
              [formatCount(summary.tracks), 'tracks'],
              [formatAdded(node.created_at), 'added'],
            ]
          : listsTracks && tracklist
            ? [
                [formatCount(tracklist.length), 'tracks'],
                [formatClock(tracklist.reduce((n, t) => n + (t.canonical_duration_ms ?? 0), 0)), 'length'],
                [formatAdded(node.created_at), 'added'],
              ]
            : []

  // Connection chips: who made it and what it's part of, from the graph's
  // own edges. A person on most of a record's tracks leads. An artist who
  // produced their own tracks (one node since #273) isn't a connection to
  // themselves; the credits tab lists that role.
  const chips = [
    ...people.filter((p) => p.role !== 'artist' && p.id !== node.id).map((p) => ({ id: p.id, label: `${p.title} · ${p.role}` })),
    ...node.edges
      .filter((e) => e.type === 'released_on' || e.type === 'member_of' || (node.type === 'recording' && e.type === 'appears_on'))
      .map((e) => ({
        id: e.other_id,
        label: `${e.other_title} · ${e.type === 'released_on' ? 'label' : e.type === 'member_of' ? 'member' : 'album'}`,
      })),
  ].slice(0, 8)

  return (
    <>
      {stats.length > 0 && (
        <dl className={`grid grid-cols-3 ${sheet ? 'mt-[14px] gap-[12px]' : 'mt-[16px] gap-[10px]'}`}>
          {stats.map(([value, label]) => (
            <Stat key={label} value={value} label={label} />
          ))}
        </dl>
      )}

      {listsTracks && tracklist && tracklist.length > 0 && (
        <Section
          label="tracks"
          action={tracklist.length > OVERVIEW_TRACKS ? <Button onClick={onShowTracks}>all {tracklist.length}</Button> : undefined}
        >
          <ol className={`mt-[4px] flex flex-col ${sheet ? '-mx-[4px]' : '-mx-[6px]'}`}>
            {tracklist.slice(0, OVERVIEW_TRACKS).map((track, i) => (
              <li key={track.id}>
                <button
                  type="button"
                  onClick={() =>
                    void playback.playTracks(
                      tracklist.map((t) => t.id),
                      i,
                      '',
                      node.type === 'release' ? { kind: 'release', nodeId: node.id } : null,
                    )
                  }
                  className={`grid w-full items-center rounded-[8px] text-left transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)] ${
                    sheet ? SHEET_TRACK_ROW : 'h-[34px] grid-cols-[18px_minmax(0,1fr)_auto] gap-[10px] px-[6px]'
                  }`}
                >
                  <span className="mono text-right text-[length:var(--text-mono)] text-[var(--color-ink-3)]">
                    {track.track_no ?? i + 1}
                  </span>
                  <span
                    className={`truncate text-[var(--color-ink)] ${sheet ? SHEET_TRACK_TITLE : 'text-[length:var(--text-body)] leading-[20px]'}`}
                  >
                    {track.title}
                  </span>
                  <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">
                    {formatDuration(track.canonical_duration_ms)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {node.type === 'artist' && node.releases.length > 0 && (
        <Section
          label="albums"
          action={node.releases.length > OVERVIEW_TRACKS ? <Button onClick={onShowTracks}>all {node.releases.length}</Button> : undefined}
        >
          <ReleaseRows releases={node.releases.slice(0, OVERVIEW_TRACKS)} onFocusNode={onFocusNode} sheet={sheet} />
        </Section>
      )}

      {chips.length > 0 && (
        <Section label="connections">
          <div className="mt-[6px] flex flex-wrap gap-[6px]">
            {chips.map((chip) => (
              <Chip key={chip.label} onClick={() => onFocusNode(chip.id)} title={chip.label}>
                {chip.label}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {node.description && (
        <Section label="about">
          <p
            data-selectable
            className="mt-[6px] text-[length:var(--text-body)] leading-[20px] [text-wrap:pretty] text-[var(--color-ink-2)]"
          >
            {node.description.body}
          </p>
          {node.description.source_url && (
            <a
              href={node.description.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-small text-[var(--color-ink-3)] hover:text-[var(--color-ink)] ${
                sheet ? 'inline-flex h-[44px] items-center' : 'mt-[6px] inline-block'
              }`}
            >
              from {node.description.source}
            </a>
          )}
        </Section>
      )}
    </>
  )
}

/* In the sheet, a record is the handoff's album row: 60px, a 48px cover,
 * the title at 15/500 over 13px. */
function ReleaseRows({
  releases,
  onFocusNode,
  sheet = false,
}: {
  releases: NodeDetail['releases']
  onFocusNode: (id: number) => void
  sheet?: boolean
}) {
  return (
    <ul className={`mt-[4px] flex flex-col ${sheet ? '-mx-[4px]' : '-mx-[6px]'}`}>
      {releases.map((release) => (
        <li key={release.id}>
          <button
            type="button"
            onClick={() => onFocusNode(release.id)}
            className={`grid w-full items-center rounded-[var(--radius-control)] text-left transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)] ${
              sheet
                ? 'h-[60px] grid-cols-[48px_minmax(0,1fr)_auto] gap-[12px] px-[4px]'
                : 'h-[48px] grid-cols-[36px_minmax(0,1fr)_auto] gap-[10px] px-[6px]'
            }`}
          >
            <CoverArt nodeId={release.id} size="thumb" radius={sheet ? 'art' : 'sm'} className={sheet ? 'size-[48px]' : 'size-[36px]'} />
            <span className="flex min-w-0 flex-col">
              <span
                className={`truncate text-[var(--color-ink)] ${sheet ? 'text-heading' : 'text-[length:var(--text-body)] leading-[20px] font-medium'}`}
              >
                {release.title}
              </span>
              <span className={`text-[var(--color-ink-2)] ${sheet ? 'text-secondary' : 'text-small'}`}>
                {[release.yearMin, plural(release.trackCount, 'track')].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{formatClock(release.totalDurationMs)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/* ---- Tracks ----------------------------------------------------------------- */

export function TracksTab({
  node,
  tracklist,
  playback,
  onFocusNode,
  sheet = false,
}: {
  node: NodeDetail
  tracklist: TracklistEntry[] | null
  playback: Playback
  onFocusNode: (id: number) => void
  sheet?: boolean
}) {
  if (node.type === 'artist')
    return (
      <div className="mt-[8px]">
        <ReleaseRows releases={node.releases} onFocusNode={onFocusNode} sheet={sheet} />
      </div>
    )
  const tracks =
    node.type === 'release' || (sheet && node.type === 'credit')
      ? (tracklist ?? [])
      : [
          {
            id: node.id,
            title: node.title,
            track_no: node.files[0]?.track_no ?? null,
            canonical_duration_ms: node.recording?.canonical_duration_ms ?? null,
          },
        ]
  const total = tracks.reduce((n, t) => n + (t.canonical_duration_ms ?? 0), 0)
  return (
    <>
      <ol className={`mt-[8px] flex flex-col ${sheet ? '-mx-[4px]' : '-mx-[6px]'}`}>
        {tracks.map((track, i) => (
          <li key={track.id}>
            <button
              type="button"
              onClick={() =>
                void playback.playTracks(
                  tracks.map((t) => t.id),
                  i,
                  '',
                  node.type === 'release' ? { kind: 'release', nodeId: node.id } : null,
                )
              }
              className={`group grid w-full items-center rounded-[var(--radius-control)] text-left transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)] ${
                sheet ? SHEET_TRACK_ROW : 'h-[42px] grid-cols-[20px_minmax(0,1fr)_auto] gap-[10px] px-[6px]'
              }`}
            >
              <span className="flex justify-end">
                <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-3)] group-hover:hidden">
                  {track.track_no ?? i + 1}
                </span>
                <span className="hidden text-[var(--color-ink)] group-hover:inline-flex">
                  <Icon name="play" size={14} filled />
                </span>
              </span>
              <span
                className={`truncate text-[var(--color-ink)] ${sheet ? SHEET_TRACK_TITLE : 'text-[length:var(--text-body)] leading-[20px]'}`}
              >
                {track.title}
              </span>
              <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">
                {formatDuration(track.canonical_duration_ms)}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-[8px] flex justify-between border-t border-[var(--color-line)] pt-[10px] text-small text-[var(--color-ink-2)]">
        <span>{plural(tracks.length, 'track')}</span>
        <span className="mono">{formatClock(total)}</span>
      </div>
    </>
  )
}

/* ---- Credits ----------------------------------------------------------------- */

const ROLE_GROUP: Record<string, string> = {
  producer: 'produced by',
  engineer: 'engineered by',
  mixing: 'mixed by',
  artist: 'performed by',
  featured: 'performed by',
  performer: 'performed by',
}

export function CreditsTab({
  node,
  people,
  reload,
  onFocusNode,
  sheet = false,
}: {
  node: NodeDetail
  people: CreditedPerson[]
  reload: () => void
  onFocusNode: (id: number) => void
  sheet?: boolean
}) {
  const groups = new Map<string, typeof people>()
  for (const person of people) {
    const group = ROLE_GROUP[person.role] ?? person.role
    groups.set(group, [...(groups.get(group) ?? []), person])
  }
  const personal = node.edges.filter((e) => e.type === 'personal')
  const [adding, setAdding] = useState(false)

  return (
    <>
      {[...groups.entries()].map(([group, members]) => (
        <Section key={group} label={group}>
          <ul>
            {members.map((person) => {
              const isCredit = person.type === 'credit'
              return (
                <li key={`${person.id}-${person.role}`}>
                  <button
                    type="button"
                    onClick={() => onFocusNode(person.id)}
                    className="flex h-[48px] w-full items-center gap-[10px] text-left"
                  >
                    {isCredit ? (
                      <span className="size-[36px] shrink-0 rounded-full bg-[var(--color-node-credit)] shadow-[var(--shadow-art-edge)]" />
                    ) : (
                      <CoverArt nodeId={person.id} size="thumb" radius="round" className="size-[36px]" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
                        {person.title || NO_VALUE}
                      </span>
                      <span className="truncate text-small text-[var(--color-ink-2)]">{person.role}</span>
                    </span>
                    {node.type !== 'recording' && (
                      <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-3)]">{plural(person.count, 'track')}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </Section>
      ))}
      {groups.size === 0 && (
        <p className="mt-[16px] text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">No credits in the tags for this one.</p>
      )}

      <Section label="your connections" action={!adding ? <Button onClick={() => setAdding(true)}>+ add</Button> : undefined}>
        {personal.length === 0 && !adding && (
          <p className="mt-[4px] text-small text-[var(--color-ink-3)]">Links you make between music show up here and on the map.</p>
        )}
        <ul className="mt-[4px] flex flex-col gap-[8px]">
          {personal.map((edge) => (
            <li key={edge.id} className="group flex items-start gap-[8px]">
              <button type="button" onClick={() => onFocusNode(edge.other_id)} className="flex min-w-0 flex-1 flex-col text-left">
                <span className="text-small text-[var(--color-ink-2)]">
                  {edge.direction === 'out' ? (edge.label ?? 'connected to') : `${edge.label ?? 'connected'} from`}
                </span>
                <span className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
                  {edge.other_title}
                </span>
                {edge.note && <span className="text-small text-[var(--color-ink-3)]">{edge.note}</span>}
              </button>
              <IconButton
                icon="cancel"
                label="Remove connection"
                // A touch has no hover to reveal it: in the sheet it's
                // always there, at 44px.
                size={sheet ? 44 : 26}
                iconSize={sheet ? 18 : undefined}
                tooltip={!sheet}
                tone="ink-3"
                className={sheet ? '' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'}
                onClick={async () => {
                  await fetch(`${API}/edges/${edge.id}`, { method: 'DELETE' })
                  reload()
                }}
              />
            </li>
          ))}
        </ul>
        {adding && (
          <NewConnection
            sheet={sheet}
            fromId={node.id}
            onDone={() => {
              setAdding(false)
              reload()
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </Section>
    </>
  )
}

/* A connection the listener makes: pick what this led to, say how, and
 * optionally why. Stored as a 'personal' edge (routes/edges.ts). */
function NewConnection({
  fromId,
  onDone,
  onCancel,
  sheet = false,
}: {
  fromId: number
  onDone: () => void
  onCancel: () => void
  sheet?: boolean
}) {
  const graph = useGraph()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ id: number; type: string; title: string }[]>([])
  const [target, setTarget] = useState<{ id: number; type: string; title: string } | null>(null)
  const [relation, setRelation] = useState('led me to')
  const [note, setNote] = useState('')

  useEffect(() => {
    const q = query.trim()
    if (!q || target) return
    let cancelled = false
    const timer = setTimeout(() => {
      fetch(`${API}/search?${new URLSearchParams({ q, limit: '6' })}`)
        .then((r) => r.json())
        .then((hits: { id: number; type: string; title: string }[]) => !cancelled && setResults(hits.filter((h) => h.id !== fromId)))
        .catch(() => undefined)
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, target, fromId])

  const add = async () => {
    if (!target || !relation.trim()) return
    await fetch(`${API}/edges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromNode: fromId,
        toNode: target.id,
        type: 'personal',
        label: relation.trim(),
        note: note.trim() || undefined,
      }),
    })
    onDone()
  }

  return (
    <div className="mt-[10px] flex flex-col gap-[10px] rounded-[var(--radius-card)] bg-[var(--color-wash)] p-[12px]">
      <SectionLabel>new connection</SectionLabel>
      {target ? (
        <div className="flex items-center gap-[10px]">
          <CoverArt nodeId={target.id} size="thumb" radius={target.type === 'artist' ? 'round' : 'sm'} className="size-[32px]" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
              {target.title}
            </span>
            <span className="truncate text-small text-[var(--color-ink-2)]">
              {[TYPE_WORD[target.type] ?? target.type, graph.byId.get(target.id)?.subtitle].filter(Boolean).join(' · ')}
            </span>
          </span>
          <Button onClick={() => setTarget(null)}>change</Button>
        </div>
      ) : (
        <>
          <TextField
            prose
            autoFocus
            size={sheet ? 'lg' : 'md'}
            label="Connect to"
            placeholder="Search for an artist, album or track"
            value={query}
            onChange={setQuery}
          />
          {results.length > 0 && (
            <ul className="flex flex-col">
              {results.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => setTarget(hit)}
                    className={`flex w-full items-center gap-[8px] rounded-[8px] px-[6px] text-left hover:bg-[var(--color-wash)] ${
                      sheet ? 'h-[44px]' : 'h-[36px]'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-secondary)] text-[var(--color-ink)]">{hit.title}</span>
                    <span className="text-small text-[var(--color-ink-3)]">{TYPE_WORD[hit.type] ?? hit.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <TextField prose size={sheet ? 'lg' : 'md'} label="Relation" placeholder="led me to" value={relation} onChange={setRelation} />
      <TextField prose size={sheet ? 'lg' : 'md'} label="Note" placeholder="note (optional)" value={note} onChange={setNote} />
      <div className="flex gap-[8px]">
        <Button variant="primary" disabled={!target || !relation.trim()} onClick={() => void add()}>
          Add connection
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          cancel
        </Button>
      </div>
    </div>
  )
}

/* ---- Metadata, edit, review ---------------------------------------------------- */

type MetadataValue = { value: string; source: 'tags' | 'musicbrainz' }
type NodeMetadata = Record<'releaseDate' | 'releaseType' | 'label' | 'mbid', MetadataValue | null>

// A value from the files' own tags reads as plain text. One only
// MusicBrainz has is marked, so it's never taken for something the files
// already say; editing a field writes a tag, and that tag is empty.
function metadataValue(entry: MetadataValue | null): ReactNode {
  if (!entry) return NO_VALUE
  if (entry.source === 'tags') return entry.value
  return (
    <span className="flex min-w-0 items-baseline gap-[6px]" title="From MusicBrainz. Not in this file's tags.">
      <span className="truncate">{entry.value}</span>
      <span className="shrink-0 text-small text-[var(--color-ink-3)]">MusicBrainz</span>
    </span>
  )
}

export function MetadataTab({
  node,
  summary,
  reload,
  sheet = false,
}: {
  node: NodeDetail
  summary: Summary | null
  reload: () => void
  sheet?: boolean
}) {
  const edit = useTagEdit(node, reload)
  const file = node.files[0]
  const editable: EditableKey[] =
    node.type === 'recording'
      ? ['releaseDate', 'releaseType', 'label', 'bpm']
      : node.type === 'release'
        ? ['releaseDate', 'releaseType', 'label']
        : []

  // Release date, type and label as GET /nodes/:id/metadata resolves them
  // (server/src/nodeMetadata.ts): a record's first track's tags, falling
  // back to what MusicBrainz matched where a tag is empty. bpm is a track's
  // own tag, read straight off its file. Refetched after a write, when the
  // node reloads.
  const metadata = useJson<NodeMetadata>(`/nodes/${node.id}/metadata`, node)
  const resolved: Record<EditableKey, MetadataValue | null> = {
    releaseDate: metadata?.releaseDate ?? null,
    releaseType: metadata?.releaseType ?? null,
    label: metadata?.label ?? null,
    bpm: file?.bpm != null ? { value: String(file.bpm), source: 'tags' } : null,
  }
  const fixed: { label: string; value: ReactNode }[] = [
    ...(node.type === 'release' && summary?.kind === 'release' ? [{ label: 'tracks', value: summary.tracks }] : []),
    ...(node.type === 'recording'
      ? [
          { label: 'track', value: file?.track_no ?? NO_VALUE },
          { label: 'length', value: formatDuration(node.recording?.canonical_duration_ms) },
        ]
      : []),
    { label: 'mbid', value: metadataValue(metadata?.mbid ?? null) },
  ]

  if (edit.phase === 'review' && edit.review) {
    return (
      <div className="mt-[14px] flex flex-col gap-[10px]">
        <SectionLabel>review before writing</SectionLabel>
        {edit.review.fields.map((f) => (
          <div key={f.field} className="flex flex-col gap-[4px] rounded-[var(--radius-card)] bg-[var(--color-wash)] p-[12px]">
            <span className="text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">{f.field}</span>
            <span className="mono flex flex-wrap items-baseline gap-x-[8px] text-[length:var(--text-mono)]">
              <span className="text-[var(--color-ink-3)] line-through">{f.old || NO_VALUE}</span>
              <span aria-hidden="true" className="text-[var(--color-ink-3)]">
                ›
              </span>
              <span className="[overflow-wrap:anywhere] text-[var(--color-ink)]">{f.new}</span>
            </span>
          </div>
        ))}
        <p className="flex items-center gap-[8px] text-small text-[var(--color-ink-2)]">
          <Icon name="info" size={14} />
          Writes tags to {plural(edit.review.fileCount, `${edit.review.format ?? ''} file`.trim())}. You can revert from Library health.
        </p>
        {edit.problem && <p className="text-small text-[var(--color-warn)]">{edit.problem}</p>}
        <div className="flex gap-[8px]">
          <Button variant="primary" disabled={edit.busy} onClick={edit.write}>
            Write to {plural(edit.review.fileCount, 'file')}
          </Button>
          <Button variant="secondary" disabled={edit.busy} onClick={edit.discard}>
            discard
          </Button>
        </div>
      </div>
    )
  }

  if (edit.phase === 'edit') {
    return (
      <div className="mt-[14px] flex flex-col">
        <p className="mb-[6px] flex items-center gap-[8px] text-small text-[var(--color-ink-2)]">
          {edit.changeCount > 0 && <StatusDot status="accent" size={6} />}
          {edit.changeCount === 0 ? 'Nothing changed yet' : `${plural(edit.changeCount, 'change')}`} · nothing is written until you review
          it
        </p>
        {editable.map((key) => (
          <div key={key} className="grid min-h-[44px] grid-cols-[110px_minmax(0,1fr)] items-center">
            <span className="flex items-center gap-[6px] text-[length:var(--text-secondary)] text-[var(--color-ink-2)]">
              {LABELS[key]}
              {edit.pending[key] && <StatusDot status="accent" size={6} />}
            </span>
            <TextField
              size={sheet ? 'lg' : 'md'}
              label={LABELS[key]}
              value={edit.draft[key] ?? ''}
              onChange={(v) => edit.update(key, v)}
              // A value only MusicBrainz has is offered, not filled in:
              // the field shows what the file says, which is nothing.
              placeholder={
                resolved[key]?.source === 'musicbrainz'
                  ? resolved[key].value
                  : key === 'releaseDate'
                    ? 'YYYY-MM-DD'
                    : key === 'bpm'
                      ? '120'
                      : undefined
              }
              inputMode={key === 'bpm' ? 'numeric' : undefined}
              onEnter={edit.submit}
              onEscape={edit.cancel}
            />
          </div>
        ))}
        <DetailRows rows={fixed.filter((r) => r.label !== 'mbid')} />
        {edit.problem && <p className="mt-[8px] text-small text-[var(--color-warn)]">{edit.problem}</p>}
        <div className="mt-[14px] flex gap-[8px]">
          <Button variant="primary" disabled={edit.changeCount === 0 || edit.busy} onClick={edit.submit}>
            {edit.changeCount > 1 ? 'Review changes' : 'Review change'}
          </Button>
          <Button variant="secondary" onClick={edit.cancel}>
            cancel
          </Button>
        </div>
      </div>
    )
  }

  const rows = [
    ...editable
      .filter((k) => k !== 'bpm' || node.type === 'recording')
      .map((key) => ({ label: LABELS[key], value: metadataValue(resolved[key]) })),
    ...fixed,
  ]
  const folder = file?.file_path ? file.file_path.slice(0, file.file_path.lastIndexOf('/') + 1) : null
  return (
    <div className="mt-[8px] flex flex-col">
      <DetailRows rows={rows} />
      {editable.length > 0 && (
        <Button variant="secondary" icon="pencil" className="mt-[12px] self-start" disabled={edit.busy} onClick={edit.start}>
          Edit
        </Button>
      )}
      {edit.problem && <p className="mt-[8px] text-small text-[var(--color-warn)]">{edit.problem}</p>}
      {node.files.length > 0 && (
        <Section
          label="files"
          action={
            <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">
              {[node.files.length, formatFormat(file?.format)].filter(Boolean).join(' · ')}
            </span>
          }
        >
          {folder && (
            <p data-selectable title={file!.file_path} className="mono mt-[4px] truncate text-[11px] text-[var(--color-ink-3)]">
              {folder}
            </p>
          )}
          <p className="text-small text-[var(--color-ink-2)]">
            {[formatFormat(file?.format), formatBitrate(file?.bitrate)].filter(Boolean).join(' · ') || NO_VALUE}
          </p>
          {node.created_at && <p className="text-small text-[var(--color-ink-3)]">added {formatWhen(node.created_at)}</p>}
        </Section>
      )}
    </div>
  )
}

function DetailsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-[12px]">
      <Skeleton className="aspect-square w-full rounded-[10px]" />
      <Skeleton className="h-[16px] w-[70%] rounded-[6px]" />
      <Skeleton tone="faint" className="h-[12px] w-[45%] rounded-[6px]" />
      <div className="mt-[12px] flex gap-[8px]">
        <Skeleton className="h-[32px] w-[84px] rounded-full" />
        <Skeleton tone="faint" className="h-[32px] w-[96px] rounded-full" />
      </div>
    </div>
  )
}
