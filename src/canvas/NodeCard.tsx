import { useEffect, useState } from 'react'
import type Sigma from 'sigma'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { IconButton } from '../ui/IconButton'
import { useMountFade } from '../ui/useMountFade'
import { formatClock, formatDuration, plural } from '../ui/format'
import { useFavourite } from '../panels/useFavourite'
import { AddToPlaylistButton } from '../panels/AddToPlaylistButton'
import type { ShellLayout } from '../shell/layout'
import { INSET, CAPSULE_HEIGHT } from '../shell/layout'
import { API_BASE as API } from '../config/serverHost'
import type { usePlayback } from '../playback/usePlayback'
import type { GraphNode } from './useGraphData'
import { useNodeAnchor, type NodeAnchor } from './useNodeAnchor'
import { NODE_CARD_OFFSET, NODE_CARD_WIDTH_PX } from './nodeCardGeometry'

/* The selected node's card: a 340px glass card opening beside the node —
 * 18px right of it and 30px above — clamped to the free space so it never
 * slides under a panel. It replaces the 665px card, which covered the
 * cluster the selection is meant to show.
 *
 * Header: a 96px cover, then what it is and when ("album · 1965"), the
 * title, the artist, and a mono summary at the foot. Actions: play, add,
 * favourite, and "details ›" into the right-hand panel for everything
 * deeper. */

// For clamping against the bottom of the free space before the card has
// measured itself: 12 + 96 + 12 + 32 + 12.
const CARD_HEIGHT_ESTIMATE = 164
const CLAMP_MARGIN = 8

type Summary =
  | { kind: 'artist'; releases: number; tracks: number }
  | { kind: 'release'; tracks: number; totalDurationMs: number; releaseDate: string | null }
  | { kind: 'recording'; trackNo: number | null; durationMs: number | null; releaseDate: string | null }
  | { kind: 'other' }

type FileFacts = { format: string | null; releaseType: string | null }

type Detail = { is_favourite: boolean; files: { format: string | null; release_type: string | null }[] }

const TYPE_WORD: Record<string, string> = { artist: 'artist', release: 'album', recording: 'track', credit: 'producer' }

function year(date: string | null | undefined): string | null {
  return date ? date.slice(0, 4) : null
}

/* The card's data: the summary for counts and dates, the node itself for
 * the heart, and — because neither says what format a record is in or
 * whether it's an album or an EP — the first track's file. Each arrives on
 * its own; the card renders what it has. */
function useCardData(node: GraphNode) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [facts, setFacts] = useState<FileFacts | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${API}/nodes/${node.id}/summary`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Summary | null) => !cancelled && setSummary(s))
      .catch(() => undefined)
    fetch(`${API}/nodes/${node.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Detail | null) => {
        if (cancelled || !d) return
        setDetail(d)
        if (node.type === 'recording') setFacts({ format: d.files[0]?.format ?? null, releaseType: d.files[0]?.release_type ?? null })
      })
      .catch(() => undefined)
    if (node.type === 'release') {
      fetch(`${API}/nodes/${node.id}/tracklist`)
        .then((r) => r.json())
        .then((tracks: { id: number }[]) => (tracks[0] ? fetch(`${API}/nodes/${tracks[0].id}`).then((r) => r.json()) : null))
        .then((first: Detail | null) => {
          if (!cancelled && first) setFacts({ format: first.files[0]?.format ?? null, releaseType: first.files[0]?.release_type ?? null })
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [node.id, node.type])

  return { summary, detail, facts }
}

function kindLine(node: GraphNode, summary: Summary | null, facts: FileFacts | null): string {
  const word = node.type === 'release' ? (facts?.releaseType?.toLowerCase() ?? 'album') : (TYPE_WORD[node.type] ?? node.type)
  const when = summary && (summary.kind === 'release' || summary.kind === 'recording') ? year(summary.releaseDate) : null
  return when ? `${word} · ${when}` : word
}

function summaryLine(summary: Summary | null, facts: FileFacts | null): string | null {
  if (!summary) return null
  const format = facts?.format?.toUpperCase() ?? null
  switch (summary.kind) {
    case 'artist':
      return `${plural(summary.releases, 'album')} · ${plural(summary.tracks, 'track')}`
    case 'release':
      return [plural(summary.tracks, 'track'), formatClock(summary.totalDurationMs), format].filter(Boolean).join(' · ')
    case 'recording':
      return [summary.trackNo != null ? `track ${summary.trackNo}` : null, formatDuration(summary.durationMs), format]
        .filter(Boolean)
        .join(' · ')
    case 'other':
      return null
  }
}

type NodeCardProps = {
  renderer: Sigma | null
  node: GraphNode
  nodeKey: string
  layout: ShellLayout
  onOpenDetails: () => void
  playback: Pick<ReturnType<typeof usePlayback>, 'playNode' | 'playAlbum' | 'playTracks' | 'queueBusy'>
}

export function NodeCard({ renderer, node, nodeKey, layout, onOpenDetails, playback }: NodeCardProps) {
  const ref = useNodeAnchor(renderer, nodeKey, (element: HTMLDivElement, { x, y }: NodeAnchor) => {
    const height = element.offsetHeight || CARD_HEIGHT_ESTIMATE
    const minX = layout.leftOccupancy + CLAMP_MARGIN
    const maxX = layout.width - layout.rightOccupancy - NODE_CARD_WIDTH_PX - CLAMP_MARGIN
    const minY = INSET + CAPSULE_HEIGHT + INSET
    const maxY = layout.height - layout.floatingBottom - height - CLAMP_MARGIN
    const left = Math.max(minX, Math.min(maxX, x + NODE_CARD_OFFSET.x))
    const top = Math.max(minY, Math.min(maxY, y - NODE_CARD_OFFSET.y))
    element.style.transform = `translate(${left}px, ${top}px)`
  })
  const shown = useMountFade()
  const { summary, detail, facts } = useCardData(node)
  const [isFavourite, toggleFavourite] = useFavourite(node.id, detail?.is_favourite ?? false)

  // An artist has no single thing to play; its card opens details instead.
  const playable = node.type === 'release' || node.type === 'recording'
  const play = () => {
    if (node.type === 'release') void playback.playAlbum(node.id)
    else if (node.type === 'recording') void playback.playNode(node.id, node.title)
  }

  return (
    <div ref={ref} className="absolute top-0 left-0" style={{ width: NODE_CARD_WIDTH_PX }}>
      <div
        role="dialog"
        aria-label={node.title}
        className="glass flex flex-col gap-[12px] rounded-[16px] p-[12px] transition-[opacity,transform] duration-[var(--motion-base)] ease-[var(--ease-out)] motion-reduce:transform-none"
        style={{ opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(4px)' }}
      >
        <div className="flex gap-[12px]">
          <CoverArt nodeId={node.id} size="thumb" radius={node.type === 'artist' ? 'round' : 'art'} alt="" className="size-[96px]" />
          <div className="flex min-w-0 flex-1 flex-col pt-[2px]">
            <span className="text-small text-[var(--color-ink-2)]">{kindLine(node, summary, facts)}</span>
            <span title={node.title} className="mt-[4px] truncate text-[16px] leading-[21px] font-medium text-[var(--color-ink)]">
              {node.title}
            </span>
            {node.subtitle && (
              <span className="truncate text-[length:var(--text-secondary)] leading-[18px] text-[var(--color-ink-2)]">{node.subtitle}</span>
            )}
            <span className="mono mt-auto truncate pt-[6px] text-[length:var(--text-mono)] text-[var(--color-ink-2)]">
              {summaryLine(summary, facts) ?? ' '}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-[2px]">
          {playable && (
            <Button variant="primary" icon="play" onClick={play} disabled={playback.queueBusy} className="mr-[6px]">
              play
            </Button>
          )}
          {node.type === 'recording' && <AddToPlaylistButton nodeId={node.id} />}
          <IconButton
            icon="heart"
            label={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
            filled={isFavourite}
            active={isFavourite}
            aria-pressed={isFavourite}
            onClick={toggleFavourite}
          />
          <Button className="ml-auto pr-[2px]" onClick={onOpenDetails}>
            details ›
          </Button>
        </div>
      </div>
    </div>
  )
}
