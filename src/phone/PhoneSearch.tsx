import { useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { PlayCircle } from '../ui/PlayCircle'
import { SectionLabel } from '../ui/SectionLabel'
import { formatDuration, plural } from '../ui/format'
import { useGraph, type GraphData } from '../canvas/graphContext'
import { playItem, useReleaseYears, useSearchRelations, type Group, type Item, type SearchRelations } from '../search/searchData'
import type { usePlayback } from '../playback/usePlayback'
import type { PhoneSearchState } from './searchState'

/* Search on the phone (#389, Legato Mobile v2 screen 4). A tap on the
 * capsule over the map turns it into a solid field, with Cancel beside it,
 * and the sheet comes up under it with the results. It's the palette's
 * search (searchData.ts): the same matches, ranked the same way, with the
 * same top result, laid out as the handoff draws it. Under the top result,
 * albums, people, tracks, then playlists; people are the palette's artists,
 * artists and the producers and engineers credited on tracks alike.
 *
 * Search is an overlay in the sheet (navigation.ts), so back closes it as
 * Cancel does, and back from a result opened from it comes back to it with
 * the query still there. Enter opens the top result. */

type Playback = ReturnType<typeof usePlayback>

const GROUP_LABEL: Record<Group['type'], string> = { release: 'albums', artist: 'people', recording: 'tracks', playlist: 'playlists' }

type SearchFieldProps = {
  search: PhoneSearchState
  onCancel: () => void
  /** Enter: open the top result. */
  onSubmit: () => void
  inputRef?: RefObject<HTMLInputElement | null>
}

/* The capsule as a field: solid, with a 1.5px accent border and an accent
 * caret, 6px under the status bar where the capsule was. Its 16px text is
 * the smallest iOS focuses without zooming the page. */
export function SearchField({ search, onCancel, onSubmit, inputRef }: SearchFieldProps) {
  const ownRef = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? ownRef
  return (
    <div className="absolute inset-x-[16px] top-[calc(env(safe-area-inset-top)+6px)] z-[25] flex items-center gap-[12px]">
      <div
        className="flex h-[48px] min-w-0 flex-1 items-center gap-[10px] rounded-[24px] border-[1.5px] border-[var(--color-accent)] bg-[var(--color-solid)] pr-[8px] pl-[16px]"
        style={{ boxShadow: 'var(--shadow-sm)' }}
      >
        <Icon name="search" size={20} className="shrink-0 text-[var(--color-ink)]" />
        <input
          ref={ref}
          autoFocus
          type="text"
          aria-label="Search artists, albums, people"
          placeholder="Search artists, albums, people"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onSubmit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] leading-[20px] text-[var(--color-ink)] caret-[var(--color-accent)] outline-none placeholder:text-[var(--color-ink-3)]"
        />
        {search.query !== '' && (
          // 32px, in a 44px target.
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              search.setQuery('')
              ref.current?.focus()
            }}
            className="relative grid size-[32px] shrink-0 place-items-center rounded-full bg-[var(--color-wash-2)] text-[var(--color-ink-2)] before:absolute before:-inset-[6px] before:content-['']"
          >
            <Icon name="cancel" size={14} />
          </button>
        )}
      </div>
      <button type="button" onClick={onCancel} className="h-[44px] shrink-0 text-heading text-[var(--color-accent)]">
        Cancel
      </button>
    </div>
  )
}

type SearchResultsProps = {
  search: PhoneSearchState
  playback: Playback
  onOpenNode: (id: number) => void
  onOpenPlaylist: (id: number) => void
  /** After a play from the results: back to the map, with the player. */
  onPlayed: () => void
}

/* The results, in the sheet. */
export function SearchResultsList({ search, playback, onOpenNode, onOpenPlaylist, onPlayed }: SearchResultsProps) {
  const graph = useGraph()
  const relations = useSearchRelations()
  const { query, results, top, groups } = search
  const people = usePeopleFacts(graph, relations)
  const shown = [...(top ? [top] : []), ...groups.flatMap((g) => g.rows)]
  const years = useReleaseYears(shown.filter((item) => item.kind === 'release').map((item) => item.id))

  const open = (item: Item) => (item.kind === 'playlist' ? onOpenPlaylist(item.id) : onOpenNode(item.id))

  const subtitle = (item: Item): string => {
    const node = graph.byId.get(item.id)
    switch (item.kind) {
      case 'artist':
        return ['artist', plural(relations.releasesOf.get(item.id)?.length ?? 0, 'album'), plural(people.tracksOf(item.id), 'track')].join(
          ' · ',
        )
      case 'credit': {
        const facts = people.credit(item.id)
        return [facts.role, facts.with ? `worked with ${facts.with}` : null].filter(Boolean).join(' · ')
      }
      case 'release':
        return [node?.subtitle, years.get(item.id)].filter(Boolean).join(' · ') || 'album'
      case 'recording':
        return node?.subtitle ?? ''
      case 'playlist': {
        const playlist = results.playlists.find((p) => p.id === item.id)
        return playlist ? `playlist · ${plural(playlist.track_count, 'track')}` : 'playlist'
      }
    }
  }

  if (!query.trim()) {
    return <p className="px-[20px] pt-[12px] text-secondary text-[var(--color-ink-3)]">Artists, albums, tracks and people</p>
  }

  if (results.hits != null && !results.pending && results.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-[8px] px-[24px] pt-[40px] pb-[40px] text-center">
        <Icon name="search" size={28} className="text-[var(--color-ink-3)]" />
        <span className="text-heading text-[var(--color-ink)]">No matches for “{query.trim()}”</span>
        <span className="text-secondary text-[var(--color-ink-2)]">Try fewer words, or part of an artist or album name.</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col px-[16px] pb-[20px]">
      {top && (
        <>
          <GroupLabel first>top result</GroupLabel>
          <div className="flex items-center rounded-[16px] bg-[var(--color-wash)] pr-[12px]">
            <button type="button" onClick={() => open(top)} className="flex min-w-0 flex-1 items-center gap-[14px] p-[12px] text-left">
              <Artwork item={top} size={56} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[17px] leading-[22px] font-medium text-[var(--color-ink)]">{top.title}</span>
                <span className="truncate text-secondary text-[var(--color-ink-2)]">{subtitle(top)}</span>
              </span>
            </button>
            {/* A producer has no one thing to play. */}
            {top.kind !== 'credit' && (
              <PlayCircle
                size={44}
                label={`Play ${top.title}`}
                disabled={playback.queueBusy}
                onClick={() => {
                  playItem(top, playback, graph, relations)
                  onPlayed()
                }}
              />
            )}
          </div>
        </>
      )}
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <section key={group.type} aria-label={GROUP_LABEL[group.type]} className="flex flex-col">
            <GroupLabel>{GROUP_LABEL[group.type]}</GroupLabel>
            {group.rows.map((item) => (
              <ResultRow
                key={item.key}
                item={item}
                subtitle={subtitle(item)}
                trailing={
                  item.kind === 'recording'
                    ? formatDuration(graph.byId.get(item.id)?.canonical_duration_ms)
                    : item.kind === 'credit'
                      ? plural(people.credit(item.id).tracks, 'track')
                      : null
                }
                onOpen={() => open(item)}
              />
            ))}
          </section>
        ))}
    </div>
  )
}

/* The handoff's group labels: 12/500 ink-2, 16px above each group but the
 * first, which sits 4px under the handle's row. */
function GroupLabel({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return <SectionLabel className={`px-[4px] ${first ? 'pt-[4px] pb-[6px]' : 'pt-[16px] pb-[4px]'}`}>{children}</SectionLabel>
}

/* A row: an album or a person at 60px with a 48px cover or avatar, a track
 * at 52px with a 40px cover and its duration. A track's title is regular
 * weight; everything else's is 500. */
function ResultRow({ item, subtitle, trailing, onOpen }: { item: Item; subtitle: string; trailing: string | null; onOpen: () => void }) {
  const track = item.kind === 'recording'
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-center gap-[12px] rounded-[var(--radius-control)] px-[4px] text-left ${track ? 'h-[52px]' : 'h-[60px]'}`}
    >
      <Artwork item={item} size={track ? 40 : 48} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate text-[15px] leading-[20px] text-[var(--color-ink)] ${track ? '' : 'font-medium'}`}>{item.title}</span>
        <span className="truncate text-secondary text-[var(--color-ink-2)]">{subtitle}</span>
      </span>
      {trailing && (
        <span
          className={`mono shrink-0 text-[length:var(--text-mono)] ${track ? 'text-[var(--color-ink-2)]' : 'text-[var(--color-ink-3)]'}`}
        >
          {trailing}
        </span>
      )}
    </button>
  )
}

/* Covers are square with the art radius (5px on a track's 40px); people are
 * round: an artist's photo, a producer or engineer in the map's credit
 * colour, since they have no picture. */
function Artwork({ item, size }: { item: Item; size: number }) {
  if (item.kind === 'playlist') {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-[var(--radius-art)] bg-[var(--color-wash-2)] text-[var(--color-ink-2)]"
        style={{ width: size, height: size }}
      >
        <Icon name="list" size={Math.round(size * 0.45)} />
      </span>
    )
  }
  if (item.kind === 'credit') {
    return (
      <span
        aria-hidden="true"
        className="shrink-0 rounded-full bg-[var(--color-node-credit)] shadow-[var(--shadow-art-edge)]"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <CoverArt
      nodeId={item.id}
      size="thumb"
      radius={item.kind === 'artist' ? 'round' : size <= 40 ? 'none' : 'art'}
      className={item.kind === 'recording' && size <= 40 ? 'rounded-[5px]' : ''}
      style={{ width: size, height: size }}
    />
  )
}

type CreditFacts = { role: string; with: string | null; tracks: number }

/* What the graph says about the people in the results: how many tracks the
 * map files under an artist, and for a producer or engineer what they did,
 * how many tracks they're credited on, and the artist they worked with
 * most. */
function usePeopleFacts(graph: GraphData, relations: SearchRelations) {
  return useMemo(() => {
    const artistTracks = new Map<number, number>()
    for (const node of graph.nodes) {
      if (node.type !== 'recording') continue
      const artist = relations.clusterOf.get(node.id)
      if (artist != null) artistTracks.set(artist, (artistTracks.get(artist) ?? 0) + 1)
    }
    const credits = new Map<number, { produced: Set<number>; engineered: Set<number>; artists: Map<number, number> }>()
    for (const edge of graph.edges) {
      if (edge.type !== 'produced_by' && edge.type !== 'engineered_by') continue
      const entry = credits.get(edge.to_node) ?? { produced: new Set(), engineered: new Set(), artists: new Map() }
      ;(edge.type === 'produced_by' ? entry.produced : entry.engineered).add(edge.from_node)
      const artist = relations.clusterOf.get(edge.from_node)
      if (artist != null) entry.artists.set(artist, (entry.artists.get(artist) ?? 0) + 1)
      credits.set(edge.to_node, entry)
    }
    return {
      tracksOf: (artistId: number) => artistTracks.get(artistId) ?? 0,
      credit: (creditId: number): CreditFacts => {
        const entry = credits.get(creditId)
        if (!entry) return { role: 'producer', with: null, tracks: 0 }
        let best: number | null = null
        for (const [artist, count] of entry.artists) if (best == null || count > (entry.artists.get(best) ?? 0)) best = artist
        return {
          role: entry.produced.size >= entry.engineered.size ? 'producer' : 'engineer',
          with: best != null ? (graph.byId.get(best)?.title ?? null) : null,
          tracks: new Set([...entry.produced, ...entry.engineered]).size,
        }
      },
    }
  }, [graph, relations])
}
