import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { Kbd } from '../ui/Kbd'
import { SectionLabel } from '../ui/SectionLabel'
import { formatDuration, plural } from '../ui/format'
import { MOD_KEY_LABEL } from '../shell/keys'
import { useShellLayout } from '../shell/layout'
import { useGraph } from '../canvas/graphContext'
import { computeClusters } from '../canvas/clusters'
import { API_BASE as API } from '../config/serverHost'
import { useReconnectEpoch } from '../connect/reconnect'
import type { usePlayback } from '../playback/usePlayback'

/* The search palette: ⌘K from anywhere, or a click on the capsule. It opens
 * in the capsule's place, over a dimmed and lightly blurred app, on an
 * opaque surface — results are read, not glanced through, and the map
 * moving behind them would only compete.
 *
 * It's presentation over the existing search: /search's full-text index
 * finds the matches, and everything shown about them — covers, artists,
 * albums, durations, counts — comes from the graph the client already
 * holds. Only a record's year needs asking for, and only for the few rows
 * on screen.
 *
 * Keys: ↑↓ move through every row in display order, ↵ opens, ⇧↵ plays,
 * ⌘↵ adds to the queue, esc closes. */

type Hit = { id: number; type: string; title: string }
type Filter = 'all' | 'artist' | 'release' | 'recording' | 'playlist'
type Playlist = { id: number; name: string; track_count: number }

/* One row anything in the palette can be: a graph node, or a playlist. */
type Item = { key: string; kind: 'artist' | 'release' | 'recording' | 'credit' | 'playlist'; id: number; title: string }

const DEBOUNCE_MS = 120
const SEARCH_LIMIT = 100
const GROUP_LIMIT: Record<Exclude<Filter, 'all'>, number> = { artist: 3, release: 4, recording: 6, playlist: 3 }
const FILTERED_LIMIT = 40

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'artist', label: 'artists' },
  { id: 'release', label: 'albums' },
  { id: 'recording', label: 'tracks' },
  { id: 'playlist', label: 'playlists' },
]

// Producers and engineers are people too: they search with the artists.
const filterOf = (kind: Item['kind']): Exclude<Filter, 'all'> => (kind === 'credit' ? 'artist' : kind)

/* The full-text search, debounced, with stale responses dropped. Asked
 * again after an outage (#119), when an answer that failed came back empty. */
function useSearch(query: string): { hits: Hit[] | null; pending: boolean } {
  const [state, setState] = useState<{ query: string; hits: Hit[] } | null>(null)
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    let cancelled = false
    const timer = setTimeout(() => {
      fetch(`${API}/search?${new URLSearchParams({ q, limit: String(SEARCH_LIMIT) })}`)
        .then((r) => r.json())
        .then((hits: Hit[]) => !cancelled && setState({ query, hits }))
        .catch(() => !cancelled && setState({ query, hits: [] }))
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, reconnects])
  if (!query.trim()) return { hits: null, pending: false }
  return { hits: state?.hits ?? null, pending: state?.query !== query }
}

function usePlaylists(): Playlist[] {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const reconnects = useReconnectEpoch()
  useEffect(() => {
    fetch(`${API}/playlists`)
      .then((r) => r.json())
      .then(setPlaylists)
      .catch(() => undefined)
  }, [reconnects])
  return playlists
}

const NO_YEARS = new Map<number, string | null>()

/* A record's year, from its summary — fetched once per record, cached for
 * the palette's life, or until an outage ends (#119): a summary that
 * failed while the server was gone is cached as no year. */
function useReleaseYears(ids: number[]): Map<number, string | null> {
  const reconnects = useReconnectEpoch()
  const [cache, setCache] = useState({ epoch: reconnects, years: new Map<number, string | null>() })
  const years = cache.epoch === reconnects ? cache.years : NO_YEARS
  const wanted = ids.filter((id) => !years.has(id)).join(',')
  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    const list = wanted.split(',').map(Number)
    void Promise.all(
      list.map((id) =>
        fetch(`${API}/nodes/${id}/summary`)
          .then((r) => (r.ok ? r.json() : null))
          .then((s: { releaseDate?: string | null } | null) => [id, s?.releaseDate?.slice(0, 4) ?? null] as const)
          .catch(() => [id, null] as const),
      ),
    ).then((entries) => {
      if (cancelled) return
      setCache((prev) => {
        const next = new Map(prev.epoch === reconnects ? prev.years : NO_YEARS)
        for (const [id, year] of entries) next.set(id, year)
        return { epoch: reconnects, years: next }
      })
    })
    return () => {
      cancelled = true
    }
  }, [wanted, reconnects])
  return years
}

type SearchPaletteProps = {
  onClose: () => void
  onOpen: (id: number) => void
  onOpenPlaylist: (id: number) => void
  playback: ReturnType<typeof usePlayback>
}

export function SearchPalette({ onClose, onOpen, onOpenPlaylist, playback }: SearchPaletteProps) {
  const layout = useShellLayout()
  const graph = useGraph()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { hits, pending } = useSearch(query)
  const playlists = usePlaylists()

  // What the graph knows that /search doesn't: each record's track count
  // and each track's record, from the edges; each artist's records, from
  // the same cluster logic the map uses.
  const relations = useMemo(() => {
    const releaseOf = new Map<number, number>()
    const trackCount = new Map<number, number>()
    for (const edge of graph.edges) {
      if (edge.type !== 'appears_on') continue
      if (!releaseOf.has(edge.from_node)) releaseOf.set(edge.from_node, edge.to_node)
      trackCount.set(edge.to_node, (trackCount.get(edge.to_node) ?? 0) + 1)
    }
    const { releasesOf, clusterOf } = computeClusters(graph.nodes, graph.edges)
    return { releaseOf, trackCount, releasesOf, clusterOf }
  }, [graph.nodes, graph.edges])

  const items = useMemo(() => {
    if (!hits) return []
    const q = query.trim().toLowerCase()
    const nodeItems: Item[] = hits
      .filter((h) => h.type === 'artist' || h.type === 'release' || h.type === 'recording' || h.type === 'credit')
      .map((h) => ({ key: `n${h.id}`, kind: h.type as Item['kind'], id: h.id, title: h.title }))
    const playlistItems: Item[] = playlists
      .filter((p) => p.name.toLowerCase().includes(q))
      .map((p) => ({ key: `p${p.id}`, kind: 'playlist', id: p.id, title: p.name }))
    return [...nodeItems, ...playlistItems]
  }, [hits, playlists, query])

  const counts = useMemo(() => {
    const c: Record<Exclude<Filter, 'all'>, number> = { artist: 0, release: 0, recording: 0, playlist: 0 }
    for (const item of items) c[filterOf(item.kind)]++
    return c
  }, [items])

  // The top result is the best match in view; the groups list the rest.
  const visible = filter === 'all' ? items : items.filter((item) => filterOf(item.kind) === filter)
  const top = visible[0] ?? null
  const groups = (filter === 'all' ? (['artist', 'release', 'recording', 'playlist'] as const) : [filter]).map((type) => ({
    type,
    rows: visible
      .filter((item) => item !== top && filterOf(item.kind) === type)
      .slice(0, filter === 'all' ? GROUP_LIMIT[type] : FILTERED_LIMIT),
  }))
  const order = [...(top ? [top] : []), ...groups.flatMap((g) => g.rows)]
  const selected = order[Math.min(cursor, order.length - 1)] ?? null

  const years = useReleaseYears(order.filter((item) => item.kind === 'release').map((item) => item.id))

  // A new query or filter starts the cursor back at the top result.
  const [cursorFor, setCursorFor] = useState({ query, filter })
  if (cursorFor.query !== query || cursorFor.filter !== filter) {
    setCursorFor({ query, filter })
    setCursor(0)
  }

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const subtitle = (item: Item): string => {
    const node = graph.byId.get(item.id)
    switch (item.kind) {
      case 'artist':
        return `artist · ${plural(relations.releasesOf.get(item.id)?.length ?? 0, 'album')}`
      case 'credit':
        return 'producer'
      case 'release': {
        const parts = [
          'album',
          years.get(item.id),
          relations.trackCount.has(item.id) ? plural(relations.trackCount.get(item.id)!, 'track') : null,
        ]
        return parts.filter(Boolean).join(' · ')
      }
      case 'recording': {
        const release = relations.releaseOf.get(item.id)
        return (release != null ? graph.byId.get(release)?.title : null) ?? node?.subtitle ?? ''
      }
      case 'playlist': {
        const playlist = playlists.find((p) => p.id === item.id)
        return playlist ? `playlist · ${plural(playlist.track_count, 'track')}` : 'playlist'
      }
    }
  }

  const open = (item: Item) => {
    if (item.kind === 'playlist') onOpenPlaylist(item.id)
    else onOpen(item.id)
  }

  const play = (item: Item) => {
    if (item.kind === 'recording') void playback.playNode(item.id, item.title)
    else if (item.kind === 'release') void playback.playAlbum(item.id)
    else if (item.kind === 'playlist') void playback.playPlaylist(item.id)
    else if (item.kind === 'artist') {
      const tracks = graph.nodes.filter((n) => n.type === 'recording' && relations.clusterOf.get(n.id) === item.id).map((n) => n.id)
      if (tracks.length) void playback.playTracks(tracks, 0, '')
    }
    onClose()
  }

  // Adds the track, or each of a record's tracks in order, after whatever is
  // already queued. Anything else has no single thing to queue.
  const enqueue = async (item: Item) => {
    if (item.kind === 'recording') await playback.addToQueue(item.id)
    else if (item.kind === 'release') {
      const tracks = (await fetch(`${API}/nodes/${item.id}/tracklist`).then((r) => r.json())) as { id: number }[]
      for (const track of tracks) await playback.addToQueue(track.id)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(order.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault()
      if (e.metaKey || e.ctrlKey) void enqueue(selected)
      else if (e.shiftKey) play(selected)
      else open(selected)
    }
  }

  const trackTotal = graph.nodes.reduce((n, node) => n + (node.type === 'recording' ? 1 : 0), 0)
  const showResults = hits != null && items.length > 0
  const noMatches = hits != null && !pending && items.length === 0

  return (
    <div className="absolute inset-0 z-40" onKeyDown={onKeyDown}>
      <div
        aria-hidden="true"
        onPointerDown={onClose}
        className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-canvas)_50%,transparent)] backdrop-blur-[4px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="absolute top-[var(--inset)] flex max-h-[calc(100%-24px)] -translate-x-1/2 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-solid)] shadow-[var(--shadow-panel)]"
        style={{ left: layout.paletteCx, width: layout.paletteWidth }}
      >
        <div className="flex h-[58px] shrink-0 items-center gap-[12px] border-b border-[var(--color-line)] px-[18px]">
          <Icon name="search" size={20} className="text-[var(--color-ink)]" />
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded={showResults}
            aria-controls="search-results"
            aria-activedescendant={selected ? `search-${selected.key}` : undefined}
            aria-label="Search artists, albums, tracks"
            placeholder="Search artists, albums, tracks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[18px] text-[var(--color-ink)] caret-[var(--color-accent)] outline-none placeholder:text-[var(--color-ink-3)]"
          />
          <Kbd>esc</Kbd>
        </div>

        {showResults && (
          <>
            <div className="flex shrink-0 flex-wrap gap-[6px] px-[16px] pt-[12px]">
              {FILTERS.map((f) => (
                <Chip key={f.id} active={filter === f.id} count={f.id === 'all' ? undefined : counts[f.id]} onClick={() => setFilter(f.id)}>
                  {f.label}
                </Chip>
              ))}
            </div>
            <div
              ref={listRef}
              id="search-results"
              role="listbox"
              aria-label="Results"
              className="grid min-h-0 grid-cols-[240px_minmax(0,1fr)] gap-[20px] overflow-y-auto p-[16px]"
            >
              {top ? (
                <TopResult
                  item={top}
                  subtitle={subtitle(top)}
                  selected={selected === top}
                  onPlay={() => play(top)}
                  onOpen={() => open(top)}
                  onHover={() => setCursor(0)}
                />
              ) : (
                <div />
              )}
              <div className="flex min-w-0 flex-col gap-[6px]">
                {groups
                  .filter((g) => g.rows.length > 0)
                  .map((group, gi) => (
                    <div key={group.type} className={`flex flex-col ${gi > 0 ? 'mt-[6px]' : ''}`}>
                      <SectionLabel className="h-[24px]">{FILTERS.find((f) => f.id === group.type)!.label}</SectionLabel>
                      {group.rows.map((item) => (
                        <ResultRow
                          key={item.key}
                          item={item}
                          subtitle={subtitle(item)}
                          duration={item.kind === 'recording' ? formatDuration(graph.byId.get(item.id)?.canonical_duration_ms) : null}
                          selected={selected === item}
                          onOpen={() => open(item)}
                          onHover={() => setCursor(order.indexOf(item))}
                        />
                      ))}
                    </div>
                  ))}
              </div>
            </div>
          </>
        )}

        {noMatches && (
          <div className="flex flex-col items-center gap-[8px] px-[24px] pt-[48px] pb-[52px] text-center">
            <Icon name="search" size={28} className="text-[var(--color-ink-3)]" />
            <span className="text-heading text-[var(--color-ink)]">No matches for “{query.trim()}”</span>
            <span className="text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">
              Try fewer words, or part of an artist or album name.
            </span>
          </div>
        )}

        <div className="flex h-[42px] shrink-0 items-center gap-[16px] border-t border-[var(--color-line)] px-[16px] text-small text-[var(--color-ink-2)]">
          <Hint keys={['↑', '↓']}>move</Hint>
          <Hint keys={['↵']}>open</Hint>
          <Hint keys={['⇧↵']}>play</Hint>
          <Hint keys={[`${MOD_KEY_LABEL}↵`]}>add to queue</Hint>
          <span className="mono ml-auto text-[var(--color-ink-3)]">{plural(trackTotal, 'track')}</span>
        </div>
      </div>
    </div>
  )
}

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-[6px]">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
      {children}
    </span>
  )
}

function Artwork({ item, size }: { item: Item; size: number }) {
  if (item.kind === 'playlist') {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-[5px] bg-[var(--color-wash-2)] text-[var(--color-ink-2)]"
        style={{ width: size, height: size }}
      >
        <Icon name="list" size={Math.round(size * 0.45)} />
      </span>
    )
  }
  const round = item.kind === 'artist' || item.kind === 'credit'
  return (
    <CoverArt
      nodeId={item.id}
      size="thumb"
      radius={round ? 'round' : size <= 32 ? 'sm' : 'art'}
      className="shrink-0"
      style={{ width: size, height: size }}
    />
  )
}

function TopResult({
  item,
  subtitle,
  selected,
  onPlay,
  onOpen,
  onHover,
}: {
  item: Item
  subtitle: string
  selected: boolean
  onPlay: () => void
  onOpen: () => void
  onHover: () => void
}) {
  return (
    <div
      id={`search-${item.key}`}
      role="option"
      aria-selected={selected}
      onPointerEnter={onHover}
      className={`flex flex-col gap-[10px] self-start rounded-[16px] p-[16px] transition-colors duration-[var(--motion-fast)] ${
        selected ? 'bg-[var(--color-wash-2)]' : 'bg-[var(--color-wash)]'
      }`}
    >
      <SectionLabel>top result</SectionLabel>
      <Artwork item={item} size={112} />
      <div className="flex min-w-0 flex-col gap-[2px]">
        <span title={item.title} className="line-clamp-2 text-title text-[var(--color-ink)]">
          {item.title}
        </span>
        <span className="truncate text-small text-[var(--color-ink-2)]">{subtitle}</span>
      </div>
      <div className="flex gap-[6px]">
        {item.kind !== 'credit' && (
          <Button variant="primary" icon="play" onClick={onPlay}>
            play
          </Button>
        )}
        <Button variant="secondary" onClick={onOpen}>
          open
        </Button>
      </div>
    </div>
  )
}

function ResultRow({
  item,
  subtitle,
  duration,
  selected,
  onOpen,
  onHover,
}: {
  item: Item
  subtitle: string
  duration: string | null
  selected: boolean
  onOpen: () => void
  onHover: () => void
}) {
  const track = item.kind === 'recording'
  return (
    <button
      type="button"
      id={`search-${item.key}`}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onOpen}
      onPointerMove={onHover}
      className={`-mx-[8px] grid items-center gap-[10px] rounded-[var(--radius-control)] px-[8px] text-left transition-colors duration-[var(--motion-fast)] ${
        track ? 'h-[44px] grid-cols-[32px_minmax(0,1fr)_auto]' : 'h-[48px] grid-cols-[40px_minmax(0,1fr)_auto]'
      } ${selected ? 'bg-[var(--color-wash-2)]' : ''}`}
    >
      <Artwork item={item} size={track ? 32 : 40} />
      <span className="flex min-w-0 flex-col">
        <span title={item.title} className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
          {item.title}
        </span>
        <span className="truncate text-small text-[var(--color-ink-2)]">{subtitle}</span>
      </span>
      {selected ? (
        <Kbd>↵</Kbd>
      ) : duration ? (
        <span className="mono text-[length:var(--text-mono)] text-[var(--color-ink-2)]">{duration}</span>
      ) : (
        <span />
      )}
    </button>
  )
}
