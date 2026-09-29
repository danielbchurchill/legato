import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/DataRow'
import { ScrollingText } from '../ui/ScrollingText'
import { Tooltip } from '../ui/Tooltip'
import { useWsEvent } from '../hooks/useWs'
import { API_BASE as API } from '../config/serverHost'
import { PlayNodeButton } from './PlayNodeButton'
import { AddToPlaylistButton } from './AddToPlaylistButton'
import type { usePlayback } from '../playback/usePlayback'

/* The search rail destination's panel content: the search field, with its
 * results rendered inline underneath it, and a condensed maintenance
 * worklist. Issue #83 retired what this panel used to also carry — the
 * collection overview moved to Database Inspector as its own top element,
 * and the similarity strips anchored on the current selection are gone
 * outright, kept only as a note that they may be rebuilt elsewhere later. */

type SearchResult = { id: number; type: string; title: string }

export type SearchFieldHandle = {
  /** Backs the app-wide "/" shortcut — focusing the field is enough to let
   * the user start typing immediately. */
  focus: () => void
}

type Playback = Pick<ReturnType<typeof usePlayback>, 'playNode' | 'playAlbum' | 'queueBusy'>

// Issue #83: results render inline again, directly under the field, rather
// than in the floating popover P-9/MO-12 introduced — that popover read as
// its own separate "mini modal" hovering over the Inspector Panel instead
// of content living in it, which is exactly the complaint the issue raised.
// The popover's real improvements — debounce, keyboard nav, ARIA wiring,
// the in-flight search icon — all carry over unchanged; only the
// positioning goes back to participating in the panel's own layout. See
// DESIGN.md's "The Search frame's Inspector Panel has one more
// unreconciled piece" for why this still isn't split into the v2 mockup's
// separate `top hits`/`suggested tracks` headers — Figma draws no rows
// under either to build against.
type SearchFieldProps = {
  onSelectNode: (id: number) => void
  playback: Playback
  /** Controlled rather than owning its own `useState` (issue #126) — the
   * library view filters against this same text, so typing here or there
   * updates one shared value instead of two independent search boxes that
   * happen to sit in different parts of the shell. */
  query: string
  onQueryChange: (query: string) => void
}

const SearchField = forwardRef<SearchFieldHandle, SearchFieldProps>(function SearchField(
  { onSelectNode, playback, query, onQueryChange },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), [])

  const [results, setResults] = useState<SearchResult[]>([])
  // Distinct from "results is empty because nothing was typed yet" —
  // DESIGN.md's "search matched nothing" state only applies once a real
  // query actually came back with zero rows.
  const [searched, setSearched] = useState(false)
  const [inFlight, setInFlight] = useState(false)
  const [highlighted, setHighlighted] = useState<number | null>(null)

  const trimmed = query.trim()
  const open = trimmed.length >= 2

  // Mount once when the results should first appear, unmount when the
  // query drops back below two characters — not on every result update
  // while it's already open, which is what makes this a once-per-session
  // entrance rather than a per-keystroke one.
  const [mounted, setMounted] = useState(false)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (open) {
      setMounted(true)
    } else {
      setMounted(false)
      setShown(false)
    }
  }, [open])
  useEffect(() => {
    if (!mounted) return
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [mounted])

  useEffect(() => {
    if (trimmed.length < 2) {
      setResults([])
      setSearched(false)
      setInFlight(false)
      return
    }

    // Debounced so typing does not fire a query per keystroke at the server.
    const timer = setTimeout(() => {
      setInFlight(true)
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
        .finally(() => setInFlight(false))
    }, 200)

    return () => clearTimeout(timer)
  }, [trimmed])

  // Highlight resets whenever the result set changes under it — a stale
  // index pointing at a row that no longer exists is worse than none.
  useEffect(() => setHighlighted(null), [results])

  const choose = (result: SearchResult) => {
    onSelectNode(result.id)
    onQueryChange('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((i) => (i == null ? 0 : Math.min(results.length - 1, i + 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((i) => (i == null ? null : Math.max(0, i - 1)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[highlighted ?? 0])
    } else if (e.key === 'Escape') {
      onQueryChange('')
    }
  }

  return (
    <div className="mb-[20px]">
      {/* v2: the field moves off --radius-surface onto --radius-control, the
       * bordered-well radius the v2 mockup actually specifies here. Still
       * inset, not raised: the field's fill is the canvas color and it
       * casts no shadow. See DESIGN.md "Raised and inset". */}
      <div className="flex h-[61px] items-center gap-[12px] rounded-[var(--radius-control)] border border-[var(--color-hairline)] bg-[var(--color-inset)] px-[20px]">
        <Icon
          name="search"
          size={24}
          className={`shrink-0 transition-colors duration-[var(--motion-fast)] ${
            inFlight ? 'text-[var(--color-ink)]' : 'text-[var(--color-muted)]'
          }`}
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Search collection"
          role="combobox"
          aria-expanded={mounted}
          aria-controls="search-results"
          aria-activedescendant={highlighted != null ? `search-result-${highlighted}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-[length:var(--text-base)] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-muted)]"
        />
      </div>

      {/* Participates in the panel's own layout now, not floated over it —
       * mounts once per search session at opacity 0 and a 2px offset, then
       * flips to settled on the next frame — same technique as
       * Tooltip.tsx — reusing --motion-fast (140ms) rather than inventing a
       * token for one specific number. The list *contents* never animate:
       * they're replaced wholesale on every debounced fetch, and a
       * transition there would just smear. */}
      {mounted && (
        <div
          className="mt-[12px] transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--ease-out)] motion-reduce:transition-none"
          style={{ opacity: shown ? 1 : 0, transform: shown ? 'translateY(0)' : 'translateY(-2px)' }}
        >
          {searched && results.length === 0 && (
            <p className="text-[length:var(--text-base)] text-[var(--color-muted)]">no matches for "{trimmed}"</p>
          )}

          {results.length > 0 && (
            <ul id="search-results" role="listbox" className="flex flex-col">
              {results.map((result, i) => (
                <li key={result.id} id={`search-result-${i}`} role="option" aria-selected={i === highlighted}>
                  {/* Not a single <button> any more (a button can't contain
                   * a button) — the row is the hover/highlight surface, the
                   * title is its own button for select-and-navigate, and
                   * play/add-to-playlist are siblings alongside it. */}
                  <div
                    onPointerEnter={() => setHighlighted(i)}
                    className={`grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-[10px] rounded-[calc(var(--radius-surface)/2)] px-[8px] py-[6px] transition-colors duration-150 ${
                      i === highlighted ? 'bg-[var(--color-hover-wash)]' : ''
                    }`}
                  >
                    <button type="button" onClick={() => choose(result)} className="min-w-0 text-left text-[var(--color-ink)]">
                      <ScrollingText text={result.title} className="font-[family-name:var(--font-mono)] text-[length:var(--text-base)]" />
                    </button>
                    <span className="text-[length:var(--text-base)] text-[var(--color-muted)]">{result.type}</span>
                    <PlayNodeButton id={result.id} type={result.type} title={result.title} playback={playback} size={18} />
                    {result.type === 'recording' && <AddToPlaylistButton nodeId={result.id} size={18} />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
})

type WorklistItem =
  | { type: 'fuzzy_pending'; fileId: number; filePath: string; nodeId: number; nodeTitle: string; candidateNodeId: number; candidateTitle: string }
  | { type: 'missing_file'; fileId: number; filePath: string; nodeId: number; nodeTitle: string; missingSince: string }
  | { type: 'wont_decode'; fileId: number; filePath: string; nodeId: number; nodeTitle: string; error: string; updatedAt: string }

// The server's worklist (server/src/hygiene.ts) also carries `enrichment_flag`
// rows — issue #83: this preview no longer surfaces them, since an
// enrichment issue now gets fixed in Tag Manager rather than from here.
// Typed separately from WorklistItem so the filter below is a real
// narrowing, not a cast, and a future worklist type still has to be added
// to both before it can render.
type ServerWorklistItem = WorklistItem | { type: 'enrichment_flag'; nodeId: number; nodeTitle: string; note: string | null; updatedAt: string }

const TYPE_LABEL: Record<WorklistItem['type'], string> = {
  fuzzy_pending: 'possible duplicate',
  wont_decode: "won't decode",
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
      .then((data: ServerWorklistItem[]) => setItems(data.filter((i): i is WorklistItem => i.type !== 'enrichment_flag')))
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
          <Tooltip label="Open maintenance">
            <button
              type="button"
              aria-label="Open maintenance"
              onClick={onOpenMaintenance}
              className="text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-muted-hi)]"
            >
              <Icon name="pencil" size={24} />
            </button>
          </Tooltip>
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
          <div className="flex items-baseline gap-[4px] text-[length:var(--text-base)] text-[var(--color-muted)]">
            <span className="shrink-0">{TYPE_LABEL[items[0].type]} —</span>
            <ScrollingText
              text={items[0].nodeTitle}
              className="min-w-0 flex-1 font-[family-name:var(--font-mono)] text-[var(--color-ink)]"
            />
          </div>
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
  onSelectNode: (id: number) => void
  onOpenMaintenance: () => void
  playback: Playback
  /** Lifted to MainApp (issue #126) — see SearchFieldProps' own comment. */
  query: string
  onQueryChange: (query: string) => void
}

export type CollectionPanelHandle = {
  /** Backs the app-wide "/" shortcut. */
  focusSearch: () => void
}

export const CollectionPanel = forwardRef<CollectionPanelHandle, CollectionPanelProps>(function CollectionPanel(
  { onSelectNode, onOpenMaintenance, playback, query, onQueryChange },
  ref,
) {
  const searchRef = useRef<SearchFieldHandle>(null)
  useImperativeHandle(ref, () => ({ focusSearch: () => searchRef.current?.focus() }), [])

  return (
    <div className="flex flex-col">
      {/* v2: the search field runs the full width of the Inspector Panel's
       * content column rather than a fixed 257px centred block — that width
       * was tuned for the old 360px panel, and the v2 panel is narrower
       * (300px) besides. The settings gear that used to sit in its own row
       * above (P-9) is gone — settings live behind the rail's own `sliders`
       * "Legato Settings" destination now, so this panel needs no entry
       * point of its own. */}
      <SearchField ref={searchRef} onSelectNode={onSelectNode} playback={playback} query={query} onQueryChange={onQueryChange} />
      <MaintenancePreview onSelectNode={onSelectNode} onOpenMaintenance={onOpenMaintenance} />
    </div>
  )
})
