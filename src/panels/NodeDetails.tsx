import { useEffect, useMemo, useState, type ReactNode } from 'react'
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
import { API, useNodeDetail, type NodeDetail } from './useNodeDetail'
import { LABELS, useTagEdit, type EditableKey } from './useTagEdit'
import { formatWhen } from './healthData'

/* Node details, in the right-hand panel: everything about one artist,
 * record or track, without covering the map the way the old full-screen
 * inspector did. "details ›" on the map's card opens it; so does anything
 * opened from the library or a search.
 *
 * The overview leads with the cover; the other tabs — tracks, credits,
 * metadata — are reading and editing views, so they shrink the header to a
 * 96px cover and give the room to their content. */

type Playback = ReturnType<typeof usePlayback>
type TracklistEntry = { id: number; title: string; track_no: number | null; canonical_duration_ms: number | null }
type Summary =
  | { kind: 'artist'; releases: number; tracks: number }
  | { kind: 'release'; tracks: number; totalDurationMs: number; releaseDate: string | null }
  | { kind: 'recording'; trackNo: number | null; durationMs: number | null; releaseDate: string | null }
  | { kind: 'other' }

const TYPE_WORD: Record<string, string> = { artist: 'artist', release: 'album', recording: 'track', credit: 'producer' }

const OVERVIEW_TRACKS = 5

function useJson<T>(path: string | null): T | null {
  const [state, setState] = useState<{ path: string; value: T | null } | null>(null)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    fetch(`${API}${path}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((value: T | null) => !cancelled && setState({ path, value }))
      .catch(() => !cancelled && setState({ path, value: null }))
    return () => {
      cancelled = true
    }
  }, [path])
  return state && state.path === path ? state.value : null
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function formatAdded(value: string | undefined): string {
  if (!value) return NO_VALUE
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? NO_VALUE : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/* What a node is made of, from the graph: a record's tracks, an artist's
 * tracks, or a track itself — and every person credited on them, with how
 * many of those tracks each one is on. */
function useCredits(node: NodeDetail | null) {
  const graph = useGraph()
  return useMemo(() => {
    if (!node) return { tracks: [] as number[], people: [] as { id: number; role: string; count: number }[] }
    let tracks: number[]
    if (node.type === 'recording') tracks = [node.id]
    else if (node.type === 'release')
      tracks = graph.edges.filter((e) => e.type === 'appears_on' && e.to_node === node.id).map((e) => e.from_node)
    else if (node.type === 'artist')
      tracks = graph.edges.filter((e) => e.type === 'performed_by' && e.to_node === node.id).map((e) => e.from_node)
    else tracks = []
    const trackSet = new Set(tracks)
    const ROLE: Record<string, string> = {
      produced_by: 'producer',
      engineered_by: 'engineer',
      mixed_by: 'mixing',
      performed_by: 'artist',
      featured_artist: 'featured',
      performed_credit: 'performer',
    }
    const counts = new Map<string, { id: number; role: string; tracks: Set<number> }>()
    for (const edge of graph.edges) {
      const role = ROLE[edge.type]
      if (!role || !trackSet.has(edge.from_node)) continue
      if (node.type === 'artist' && edge.to_node === node.id) continue
      const key = `${edge.to_node}:${role}`
      const entry = counts.get(key) ?? { id: edge.to_node, role, tracks: new Set<number>() }
      entry.tracks.add(edge.from_node)
      counts.set(key, entry)
    }
    const people = [...counts.values()].map((e) => ({ id: e.id, role: e.role, count: e.tracks.size })).sort((a, b) => b.count - a.count)
    return { tracks, people }
  }, [node, graph.edges])
}

type NodeDetailsProps = {
  nodeId: number
  tab: DetailsTab
  onTabChange: (tab: DetailsTab) => void
  playback: Playback
  onFocusNode: (id: number) => void
}

export function NodeDetails({ nodeId, tab, onTabChange, playback, onFocusNode }: NodeDetailsProps) {
  const { node, reload } = useNodeDetail(nodeId)
  const graph = useGraph()
  const summary = useJson<Summary>(`/nodes/${nodeId}/summary`)
  const tracklist = useJson<TracklistEntry[]>(node?.type === 'release' ? `/nodes/${nodeId}/tracklist` : null)
  const credits = useCredits(node && node.id === nodeId ? node : null)

  if (!node || node.id !== nodeId) return <DetailsSkeleton />

  const artistEdge = node.edges.find((e) => e.direction === 'out' && e.type === 'performed_by')
  const artistName = node.type === 'artist' ? null : (artistEdge?.other_title ?? graph.byId.get(node.id)?.subtitle ?? null)
  const artistId = artistEdge?.other_id ?? null
  const year = summary && (summary.kind === 'release' || summary.kind === 'recording') ? summary.releaseDate?.slice(0, 4) : null
  const releaseType = node.files[0]?.release_type?.toLowerCase()
  const kindLine = [node.type === 'release' ? (releaseType ?? 'album') : (TYPE_WORD[node.type] ?? node.type), year]
    .filter(Boolean)
    .join(' · ')

  const play = () => {
    if (node.type === 'release') void playback.playAlbum(node.id)
    else if (node.type === 'recording') void playback.playNode(node.id, node.title)
    else if (credits.tracks.length) void playback.playTracks(credits.tracks, 0, '')
  }
  const shuffleAll = () => {
    const ids = node.type === 'release' && tracklist ? tracklist.map((t) => t.id) : credits.tracks
    if (ids.length) void playback.playTracks(shuffle(ids), 0, '', node.type === 'release' ? { kind: 'release', nodeId: node.id } : null)
  }
  const tabs = [
    { value: 'overview', label: 'overview' },
    { value: 'tracks', label: node.type === 'artist' ? 'albums' : 'tracks' },
    { value: 'credits', label: 'credits' },
    { value: 'metadata', label: 'metadata' },
  ] as const satisfies readonly { value: DetailsTab; label: string }[]

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
        {(node.type === 'release' || node.type === 'recording' || credits.tracks.length > 0) && (
          <Button variant="primary" icon="play" onClick={play} disabled={playback.queueBusy}>
            play
          </Button>
        )}
        {node.type !== 'recording' && credits.tracks.length > 1 && (
          <Button variant="secondary" icon="arrow-swap" onClick={shuffleAll} disabled={playback.queueBusy}>
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

function FavouriteButton({ node }: { node: NodeDetail }) {
  const [isFavourite, toggle] = useFavourite(node.id, node.is_favourite)
  return (
    <IconButton
      icon="heart"
      label={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
      filled={isFavourite}
      active={isFavourite}
      aria-pressed={isFavourite}
      onClick={toggle}
    />
  )
}

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

function Overview({
  node,
  summary,
  tracklist,
  people,
  onShowTracks,
  playback,
  onFocusNode,
}: {
  node: NodeDetail
  summary: Summary | null
  tracklist: TracklistEntry[] | null
  people: { id: number; role: string; count: number }[]
  onShowTracks: () => void
  playback: Playback
  onFocusNode: (id: number) => void
}) {
  const graph = useGraph()
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
          : []

  // Connection chips: who made it and what it's part of, from the graph's
  // own edges. A person on most of a record's tracks leads.
  const chips = [
    ...people.filter((p) => p.role !== 'artist').map((p) => ({ id: p.id, label: `${graph.byId.get(p.id)?.title ?? '?'} · ${p.role}` })),
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
        <dl className="mt-[16px] grid grid-cols-3 gap-[10px]">
          {stats.map(([value, label]) => (
            <Stat key={label} value={value} label={label} />
          ))}
        </dl>
      )}

      {node.type === 'release' && tracklist && tracklist.length > 0 && (
        <Section
          label="tracks"
          action={tracklist.length > OVERVIEW_TRACKS ? <Button onClick={onShowTracks}>all {tracklist.length}</Button> : undefined}
        >
          <ol className="-mx-[6px] mt-[4px] flex flex-col">
            {tracklist.slice(0, OVERVIEW_TRACKS).map((track, i) => (
              <li key={track.id}>
                <button
                  type="button"
                  onClick={() =>
                    void playback.playTracks(
                      tracklist.map((t) => t.id),
                      i,
                      '',
                      { kind: 'release', nodeId: node.id },
                    )
                  }
                  className="grid h-[34px] w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-[10px] rounded-[8px] px-[6px] text-left transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)]"
                >
                  <span className="mono text-right text-[length:var(--text-mono)] text-[var(--color-ink-3)]">
                    {track.track_no ?? i + 1}
                  </span>
                  <span className="truncate text-[length:var(--text-body)] leading-[20px] text-[var(--color-ink)]">{track.title}</span>
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
          <ReleaseRows releases={node.releases.slice(0, OVERVIEW_TRACKS)} onFocusNode={onFocusNode} />
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
              className="mt-[6px] inline-block text-small text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              from {node.description.source}
            </a>
          )}
        </Section>
      )}
    </>
  )
}

function ReleaseRows({ releases, onFocusNode }: { releases: NodeDetail['releases']; onFocusNode: (id: number) => void }) {
  return (
    <ul className="-mx-[6px] mt-[4px] flex flex-col">
      {releases.map((release) => (
        <li key={release.id}>
          <button
            type="button"
            onClick={() => onFocusNode(release.id)}
            className="grid h-[48px] w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-[10px] rounded-[var(--radius-control)] px-[6px] text-left transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)]"
          >
            <CoverArt nodeId={release.id} size="thumb" radius="sm" className="size-[36px]" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
                {release.title}
              </span>
              <span className="text-small text-[var(--color-ink-2)]">
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

function TracksTab({
  node,
  tracklist,
  playback,
  onFocusNode,
}: {
  node: NodeDetail
  tracklist: TracklistEntry[] | null
  playback: Playback
  onFocusNode: (id: number) => void
}) {
  if (node.type === 'artist')
    return (
      <div className="mt-[8px]">
        <ReleaseRows releases={node.releases} onFocusNode={onFocusNode} />
      </div>
    )
  const tracks =
    node.type === 'release'
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
      <ol className="-mx-[6px] mt-[8px] flex flex-col">
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
              className="group grid h-[42px] w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-[10px] rounded-[var(--radius-control)] px-[6px] text-left transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)]"
            >
              <span className="flex justify-end">
                <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-3)] group-hover:hidden">
                  {track.track_no ?? i + 1}
                </span>
                <span className="hidden text-[var(--color-ink)] group-hover:inline-flex">
                  <Icon name="play" size={14} filled />
                </span>
              </span>
              <span className="truncate text-[length:var(--text-body)] leading-[20px] text-[var(--color-ink)]">{track.title}</span>
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

function CreditsTab({
  node,
  people,
  reload,
  onFocusNode,
}: {
  node: NodeDetail
  people: { id: number; role: string; count: number }[]
  reload: () => void
  onFocusNode: (id: number) => void
}) {
  const graph = useGraph()
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
              const isCredit = graph.byId.get(person.id)?.type === 'credit'
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
                        {graph.byId.get(person.id)?.title ?? NO_VALUE}
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
                size={26}
                tone="ink-3"
                className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
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
function NewConnection({ fromId, onDone, onCancel }: { fromId: number; onDone: () => void; onCancel: () => void }) {
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
                    className="flex h-[36px] w-full items-center gap-[8px] rounded-[8px] px-[6px] text-left hover:bg-[var(--color-wash)]"
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
      <TextField prose label="Relation" placeholder="led me to" value={relation} onChange={setRelation} />
      <TextField prose label="Note" placeholder="note (optional)" value={note} onChange={setNote} />
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

function MetadataTab({ node, summary, reload }: { node: NodeDetail; summary: Summary | null; reload: () => void }) {
  const edit = useTagEdit(node, reload)
  const file = node.files[0]
  const editable: EditableKey[] =
    node.type === 'recording'
      ? ['releaseDate', 'releaseType', 'label', 'bpm']
      : node.type === 'release'
        ? ['releaseDate', 'releaseType', 'label']
        : []

  const current: Record<EditableKey, string | null> = {
    releaseDate: file?.release_date ?? (summary && 'releaseDate' in summary ? summary.releaseDate : null),
    releaseType: file?.release_type ?? null,
    label: file?.label ?? null,
    bpm: file?.bpm != null ? String(file.bpm) : null,
  }
  const fixed: { label: string; value: ReactNode }[] = [
    ...(node.type === 'release' && summary?.kind === 'release' ? [{ label: 'tracks', value: summary.tracks }] : []),
    ...(node.type === 'recording'
      ? [
          { label: 'track', value: file?.track_no ?? NO_VALUE },
          { label: 'length', value: formatDuration(node.recording?.canonical_duration_ms) },
        ]
      : []),
    { label: 'mbid', value: node.mbid ?? NO_VALUE },
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
              label={LABELS[key]}
              value={edit.draft[key] ?? ''}
              onChange={(v) => edit.update(key, v)}
              placeholder={key === 'releaseDate' ? 'YYYY-MM-DD' : key === 'bpm' ? '120' : undefined}
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
      .map((key) => ({ label: LABELS[key], value: current[key] ?? NO_VALUE })),
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
