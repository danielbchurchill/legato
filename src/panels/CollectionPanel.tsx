import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import { CoverArt } from '../ui/CoverArt'
import { DataRow, SectionHeader } from '../ui/DataRow'
import { useWsEvent } from '../hooks/useWs'
import { formatBytes, formatDurationHours } from './format'

const API = 'http://127.0.0.1:8899/api/v1'

/* The left-hand panel: search, the real collection overview, similarity
 * strips anchored on whatever is selected (or playing), and a condensed
 * maintenance worklist. */

type SearchResult = { id: number; type: string; title: string }

function SearchField({ onSelectNode }: { onSelectNode: (id: number) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  // Distinct from "results is empty because nothing was typed yet" —
  // DESIGN.md's "search matched nothing" state only applies once a real
  // query actually came back with zero rows.
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      setSearched(false)
      return
    }

    // Debounced so typing does not fire a query per keystroke at the server.
    const timer = setTimeout(() => {
      fetch(`${API}/search?q=${encodeURIComponent(trimmed)}&limit=8`)
        .then((r) => r.json())
        .then((data: SearchResult[]) => {
          setResults(data)
          setSearched(true)
        })
        .catch(() => {
          setResults([])
          setSearched(true)
        })
    }, 200)

    return () => clearTimeout(timer)
  }, [query])

  return (
    <div>
      {/* Inset, not raised: the field's fill is the canvas color and it casts
       * no shadow. See DESIGN.md "Raised and inset". */}
      <div className="flex h-[61px] items-center gap-[12px] rounded-[var(--radius-surface)] border border-[var(--color-hairline)] bg-[var(--color-inset)] px-[20px]">
        <Icon name="search" size={24} className="text-[var(--color-muted)]" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search collection"
          className="min-w-0 flex-1 bg-transparent text-[length:var(--text-base)] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
        />
      </div>

      {searched && results.length === 0 && (
        <p className="mt-[12px] text-[length:var(--text-base)] text-[var(--color-muted)]">
          no matches for "{query.trim()}"
        </p>
      )}

      {results.length > 0 && (
        <ul className="mt-[12px] flex flex-col">
          {results.map((result) => (
            <li key={result.id}>
              <button
                type="button"
                onClick={() => {
                  onSelectNode(result.id)
                  setQuery('')
                }}
                className="grid w-full grid-cols-[1fr_auto] items-center gap-[10px] py-[6px] text-left"
              >
                <span className="truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
                  {result.title}
                </span>
                <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">
                  {result.type}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type Stats = {
  artists: number
  albums: number
  tracks: number
  totalBytes: number
  totalDurationMs: number
  topArtist: { id: number; title: string } | null
  topAlbum: { id: number; title: string } | null
  topTrack: { id: number; title: string } | null
}

function OverviewBlock() {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    fetch(`${API}/stats`)
      .then((r) => r.json())
      .then(setStats)
      .catch(() => setStats(null))
  }, [])

  // Absent rather than stubbed while loading or on failure — a row of
  // dashes reads as broken, not as "still loading."
  if (!stats) return null

  return (
    <>
      <SectionHeader
        title="overview"
        action={
          <button
            type="button"
            aria-label="About these stats"
            title="Top artist/album/track are based on real play history — 50% of a track's duration or 4 minutes listened, whichever comes first."
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-ink)]"
          >
            <Icon name="info" size={24} />
          </button>
        }
      />
      <div className="mt-[8px]">
        <DataRow label="artists" value={stats.artists.toLocaleString()} />
        <DataRow label="albums" value={stats.albums.toLocaleString()} />
        <DataRow label="tracks" value={stats.tracks.toLocaleString()} />
        <DataRow label="size" value={formatBytes(stats.totalBytes)} />
        <DataRow label="duration" value={formatDurationHours(stats.totalDurationMs)} />
        {stats.topArtist && <DataRow label="top artist" value={stats.topArtist.title} />}
        {stats.topAlbum && <DataRow label="top album" value={stats.topAlbum.title} />}
        {stats.topTrack && <DataRow label="top track" value={stats.topTrack.title} />}
      </div>
    </>
  )
}

type SimilarityItem = { id: number; title: string; has_cover: number }

function SimilarityStrip({
  title,
  items,
  onSelectNode,
}: {
  title: string
  items: SimilarityItem[]
  onSelectNode: (id: number) => void
}) {
  // Absent rather than a strip of grey squares — nothing to show is a
  // normal state (the anchor isn't a recording, or the library is too
  // small/uniform to have a real contrast), not a broken feature.
  if (items.length === 0) return null

  return (
    <>
      <SectionHeader title={title} />
      <div className="mt-[8px] grid grid-cols-3 gap-[15px]">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectNode(item.id)}
            className="h-[75px] w-[75px]"
          >
            <CoverArt nodeId={item.id} size="thumb" alt={item.title} className="h-full w-full" />
          </button>
        ))}
      </div>
    </>
  )
}

function SimilaritySection({ anchorNodeId, onSelectNode }: { anchorNodeId: number | null; onSelectNode: (id: number) => void }) {
  const [similar, setSimilar] = useState<SimilarityItem[]>([])
  const [dissimilar, setDissimilar] = useState<SimilarityItem[]>([])

  useEffect(() => {
    if (anchorNodeId == null) {
      setSimilar([])
      setDissimilar([])
      return
    }
    fetch(`${API}/nodes/${anchorNodeId}/similar`)
      .then((r) => r.json())
      .then(setSimilar)
      .catch(() => setSimilar([]))
    fetch(`${API}/nodes/${anchorNodeId}/dissimilar`)
      .then((r) => r.json())
      .then(setDissimilar)
      .catch(() => setDissimilar([]))
  }, [anchorNodeId])

  return (
    <>
      <SimilarityStrip title="more like this" items={similar} onSelectNode={onSelectNode} />
      <SimilarityStrip title="completely different" items={dissimilar} onSelectNode={onSelectNode} />
    </>
  )
}

type WorklistItem =
  | { type: 'fuzzy_pending'; fileId: number; filePath: string; nodeId: number; nodeTitle: string; candidateNodeId: number; candidateTitle: string }
  | { type: 'enrichment_flag'; nodeId: number; nodeTitle: string; note: string | null; updatedAt: string }
  | { type: 'missing_file'; fileId: number; filePath: string; nodeId: number; nodeTitle: string; missingSince: string }

const TYPE_LABEL: Record<WorklistItem['type'], string> = {
  fuzzy_pending: 'possible duplicate',
  enrichment_flag: 'enrichment issue',
  missing_file: 'missing file',
}

function MaintenancePreview({
  onSelectNode,
  onOpenMaintenance,
}: {
  onSelectNode: (id: number) => void
  onOpenMaintenance: () => void
}) {
  const [items, setItems] = useState<WorklistItem[] | null>(null)

  const load = () => {
    fetch(`${API}/hygiene/worklist`)
      .then((r) => r.json())
      .then(setItems)
      .catch(() => setItems([]))
  }

  useEffect(load, [])
  // Resolving a fuzzy-pending match, an enrichment job finishing, or a
  // re-scan finding/losing a file all broadcast events that can change this
  // worklist — see hygiene/HygieneView.tsx for the same wiring.
  useWsEvent(['hygiene:changed', 'scan:done', 'scan:file'], load)

  if (items === null) return null

  return (
    <>
      <SectionHeader
        title="maintenance"
        action={
          <button
            type="button"
            aria-label="Open maintenance"
            title="Open maintenance"
            onClick={onOpenMaintenance}
            className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-ink)]"
          >
            <Icon name="pencil" size={24} />
          </button>
        }
      />
      {items.length === 0 ? (
        // A success state, not an empty one — DESIGN.md "No maintenance
        // items ... should read as calm, not empty."
        <p className="mt-[8px] text-[length:var(--text-base)] text-[var(--color-muted)]">nothing needs attention</p>
      ) : (
        <button
          type="button"
          onClick={() => onSelectNode(items[0].nodeId)}
          className="mt-[8px] block w-full text-left"
        >
          <span className="block truncate font-[family-name:var(--font-mono)] text-[length:var(--text-base)] text-[var(--color-ink)]">
            {TYPE_LABEL[items[0].type]} — {items[0].nodeTitle}
          </span>
          {items.length > 1 && (
            <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">
              +{items.length - 1} other{items.length - 1 === 1 ? '' : 's'}
            </span>
          )}
        </button>
      )}
    </>
  )
}

type CollectionPanelProps = {
  anchorNodeId: number | null
  onSelectNode: (id: number) => void
  onOpenMaintenance: () => void
  onOpenSettings: () => void
}

export function CollectionPanel({ anchorNodeId, onSelectNode, onOpenMaintenance, onOpenSettings }: CollectionPanelProps) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-[12px]">
        <div className="min-w-0 flex-1">
          <SearchField onSelectNode={onSelectNode} />
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Open settings"
          className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-ink)]"
        >
          <Icon name="settings" size={24} />
        </button>
      </div>
      <OverviewBlock />
      <SimilaritySection anchorNodeId={anchorNodeId} onSelectNode={onSelectNode} />
      <MaintenancePreview onSelectNode={onSelectNode} onOpenMaintenance={onOpenMaintenance} />
    </div>
  )
}
