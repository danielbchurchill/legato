import { useState, type Ref } from 'react'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { Skeleton } from '../ui/Skeleton'
import { Tabs } from '../ui/Tabs'
import { TouchLayoutContext } from '../ui/touchLayout'
import { useCoverColor, withAlpha } from '../ui/coverColor'
import { PlaylistPicker } from '../panels/AddToPlaylistButton'
import { CreditsTab, FavouriteButton, MetadataTab, Overview, TracksTab } from '../panels/NodeDetails'
import { shuffle, type NodeDetailsData } from '../panels/nodeDetailsData'
import { enqueueItem } from '../search/searchData'
import type { usePlayback } from '../playback/usePlayback'
import type { PhoneNodeState } from './nodeDetail'

/* A node's detail on the phone (#389, Legato Mobile v2 screen 5): the
 * desktop's details panel, drawn in the sheet at the medium detent with the
 * node centred on the map above it.
 *
 * Over the map, a back button and "centre on map" take the search capsule's
 * place. In the sheet, the header (it stays put while the tab scrolls, and
 * drags the sheet) is the cover beside the kind and year, the title and the
 * artist, then play, shuffle, the heart and "more", then the tabs. A wash
 * of the cover's colour fades down the top 260px, the colour the desktop's
 * panel takes its own wash from (ui/coverColor.ts). The tabs are the
 * desktop's own (panels/NodeDetails.tsx), from the same endpoints, in the
 * phone's touch layout.
 *
 * The handoff draws an album. An artist follows it with a round photo, and
 * lists its albums where an album lists its tracks; a track has its own one
 * row; a producer or engineer has no art, so its round avatar is the map's
 * credit colour, and its tracks are the ones it's credited on. Artists and
 * credits have nothing for "more" to offer, so they show the heart alone. */

type Playback = ReturnType<typeof usePlayback>

type NodeControlsProps = {
  onBack: () => void
  onCentre: () => void
  /** The pill fades as the sheet comes up to large, with the dim. */
  pillRef?: Ref<HTMLDivElement>
  /** While the sheet is large the pill is gone. Back stays: it's above
   * the dim, in the strip of map large leaves. */
  pillHidden: boolean
}

/* Glass with the small shadow, as the handoff draws both. */
export function NodeControls({ onBack, onCentre, pillRef, pillHidden }: NodeControlsProps) {
  return (
    <>
      <button
        type="button"
        aria-label="Back"
        onClick={onBack}
        className="glass absolute top-[calc(env(safe-area-inset-top)+6px)] left-[16px] z-[25] grid size-[44px] place-items-center rounded-full text-[var(--color-ink)]"
        style={{ boxShadow: 'var(--shadow-sm)' }}
      >
        <span className="inline-flex rotate-90">
          <Icon name="chevron-down" size={20} />
        </span>
      </button>
      <div ref={pillRef} inert={pillHidden} className="absolute top-[calc(env(safe-area-inset-top)+6px)] right-[16px] z-10">
        <button
          type="button"
          onClick={onCentre}
          className="glass flex h-[44px] items-center gap-[8px] rounded-[22px] pr-[16px] pl-[12px] text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]"
          style={{ boxShadow: 'var(--shadow-sm)' }}
        >
          <Icon name="target" size={18} className="text-[var(--color-accent)]" />
          centre on map
        </button>
      </div>
    </>
  )
}

type NodeSheetProps = {
  node: PhoneNodeState
  playback: Playback
  /** A link inside the detail: its album, its artist, a credit. */
  onOpenNode: (id: number) => void
}

/** The sheet's header while it shows a node. */
export function NodeHeader({ node, playback, onOpenNode }: NodeSheetProps) {
  const color = useCoverColor(node.id)
  const details = node.details
  return (
    <TouchLayoutContext.Provider value={true}>
      {color != null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[260px] rounded-t-[28px]"
          style={{ background: `linear-gradient(180deg, ${withAlpha(color, 0.22)}, ${withAlpha(color, 0)} 260px)` }}
        />
      )}
      {details == null ? <HeaderSkeleton /> : <Header details={details} node={node} playback={playback} onOpenNode={onOpenNode} />}
    </TouchLayoutContext.Provider>
  )
}

function Header({ details, node, playback, onOpenNode }: NodeSheetProps & { details: NodeDetailsData }) {
  const { node: detail, kindLine, artistName, artistId } = details
  const credit = detail.type === 'credit'
  // A producer or engineer plays the tracks they're credited on, which the
  // sheet lists for them (nodeDetailsData.ts).
  const creditIds = credit ? (details.tracklist ?? []).map((t) => t.id) : null
  const canPlay = creditIds ? creditIds.length > 0 : details.canPlay
  const canShuffle = creditIds ? creditIds.length > 1 : details.canShuffle
  const play = creditIds ? () => void playback.playTracks(creditIds, 0, '') : details.play
  const shuffleAll = creditIds ? () => void playback.playTracks(shuffle(creditIds), 0, '') : details.shuffle
  return (
    <div className="relative flex flex-col px-[20px] pt-[2px]">
      <div className="flex items-end gap-[14px]">
        {credit ? (
          <span
            aria-hidden="true"
            className="size-[88px] shrink-0 rounded-full bg-[var(--color-node-credit)] shadow-[var(--shadow-art-edge)]"
          />
        ) : (
          <CoverArt
            nodeId={detail.id}
            size="full"
            alt={`Cover art for ${detail.title}`}
            radius={detail.type === 'artist' ? 'round' : 'none'}
            className={`shadow-[var(--shadow-sm)] ${detail.type === 'artist' ? '' : 'rounded-[8px]'}`}
            style={{ width: 88, height: 88 }}
          />
        )}
        <div className="flex min-w-0 flex-col gap-[2px]">
          <span className="text-small text-[var(--color-ink-2)]">{kindLine}</span>
          <h2 className="line-clamp-2 text-[21px] leading-[26px] font-medium [overflow-wrap:anywhere] text-[var(--color-ink)]">
            {detail.title}
          </h2>
          {artistName &&
            (artistId != null ? (
              <button
                type="button"
                onClick={() => onOpenNode(artistId)}
                className="touch-target self-start truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]"
              >
                {artistName}
              </button>
            ) : (
              <span className="truncate text-[length:var(--text-body)] leading-[20px] font-medium text-[var(--color-ink)]">
                {artistName}
              </span>
            ))}
        </div>
      </div>

      <div className="mt-[16px] flex items-center gap-[8px]">
        {canPlay && (
          <Button variant="primary" size="sheet" icon="play" onClick={play} disabled={playback.queueBusy}>
            play
          </Button>
        )}
        {canShuffle && (
          <Button variant="secondary" size="sheet" icon="arrow-swap" onClick={shuffleAll} disabled={playback.queueBusy}>
            shuffle
          </Button>
        )}
        <span className="ml-auto flex">
          <FavouriteButton node={detail} sheet />
          {(detail.type === 'release' || detail.type === 'recording') && (
            <MoreMenu details={details} playback={playback} onEditTags={() => node.setTab('metadata')} />
          )}
        </span>
      </div>

      <Tabs
        label="details"
        variant="underline"
        size="md"
        options={details.tabs}
        value={node.tab}
        onChange={node.setTab}
        className="mt-[16px] w-full border-b border-[var(--color-line)]"
      />
    </div>
  )
}

/* The 88px cover, the three lines and the actions, while the node loads. */
function HeaderSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="relative flex flex-col px-[20px] pt-[2px]">
      <div className="flex items-end gap-[14px]">
        <Skeleton className="size-[88px] rounded-[8px]" />
        <div className="flex flex-1 flex-col gap-[8px] pb-[4px]">
          <Skeleton tone="faint" className="h-[12px] w-[40%] rounded-[6px]" />
          <Skeleton className="h-[20px] w-[75%] rounded-[6px]" />
          <Skeleton tone="faint" className="h-[14px] w-[45%] rounded-[6px]" />
        </div>
      </div>
      <div className="mt-[16px] flex gap-[8px]">
        <Skeleton className="h-[44px] w-[92px] rounded-full" />
        <Skeleton tone="faint" className="h-[44px] w-[112px] rounded-full" />
      </div>
      <div className="mt-[16px] h-[41px] border-b border-[var(--color-line)]" />
    </div>
  )
}

/* "more": what the desktop's panel has beside the heart, for a record or a
 * track. Add to queue, add to playlist (a track; the menu turns into the
 * playlist picker), and edit tags, which opens the metadata tab where Edit
 * is, as the desktop's pencil does. */
function MoreMenu({ details, playback, onEditTags }: { details: NodeDetailsData; playback: Playback; onEditTags: () => void }) {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const { node } = details
  const item = { kind: node.type === 'release' ? ('release' as const) : ('recording' as const), id: node.id }
  return (
    <Popover
      label={picking ? 'Add to playlist' : 'More'}
      placement="bottom"
      align="end"
      className="w-[240px] p-[6px]"
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setPicking(false)
      }}
      trigger={({ open: isOpen, ...props }) => (
        <button
          type="button"
          {...props}
          aria-label="More"
          className={`grid size-[44px] place-items-center rounded-[14px] transition-colors duration-[var(--motion-fast)] ${
            isOpen ? 'bg-[var(--color-wash-2)] text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
          }`}
        >
          <Icon name="more" size={21} />
        </button>
      )}
    >
      {(close) =>
        picking ? (
          <PlaylistPicker nodeId={node.id} onDone={close} sheet />
        ) : (
          <ul className="flex flex-col">
            <MenuItem
              onClick={() => {
                void enqueueItem(item, playback)
                close()
              }}
            >
              add to queue
            </MenuItem>
            {node.type === 'recording' && <MenuItem onClick={() => setPicking(true)}>add to playlist</MenuItem>}
            <MenuItem
              onClick={() => {
                onEditTags()
                close()
              }}
            >
              edit tags
            </MenuItem>
          </ul>
        )
      }
    </Popover>
  )
}

function MenuItem({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex h-[44px] w-full items-center rounded-[10px] px-[12px] text-left text-[length:var(--text-body)] text-[var(--color-ink)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-wash)]"
      >
        {children}
      </button>
    </li>
  )
}

/** The tab under the header, in the sheet's place for content. */
export function NodeBody({ node, playback, onOpenNode }: NodeSheetProps) {
  const details = node.details
  if (details == null) return null
  const { node: detail, summary, tracklist, credits, reload } = details
  return (
    <TouchLayoutContext.Provider value={true}>
      <div className="px-[20px] pb-[20px]">
        {node.tab === 'overview' && (
          <Overview
            sheet
            node={detail}
            summary={summary}
            tracklist={tracklist}
            people={credits.people}
            onShowTracks={() => node.setTab('tracks')}
            playback={playback}
            onFocusNode={onOpenNode}
          />
        )}
        {node.tab === 'tracks' && <TracksTab sheet node={detail} tracklist={tracklist} playback={playback} onFocusNode={onOpenNode} />}
        {node.tab === 'credits' && <CreditsTab sheet node={detail} people={credits.people} reload={reload} onFocusNode={onOpenNode} />}
        {node.tab === 'metadata' && <MetadataTab sheet key={detail.id} node={detail} summary={summary} reload={reload} />}
      </div>
    </TouchLayoutContext.Provider>
  )
}
