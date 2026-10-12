import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { AppShell } from '../shell/AppShell'
import { ShellLayoutContext, useWindowSize } from '../shell/layout'
import { Button } from '../ui/Button'
import { ErrorBoundary, RenderError } from '../ui/ErrorBoundary'
import { Tabs } from '../ui/Tabs'
import { plural } from '../ui/format'
import { useCoverColor, withAlpha } from '../ui/coverColor'
import { useLibraryChanges, useLibraryStats } from '../library/useLibraryChanges'
import { ServerUnreachableOverShell, type UnreachableView } from '../connect/ServerUnreachable'
import type { Settings } from '../hooks/useSettings'
import type { ThemePreference } from '../hooks/useTheme'
import { NEXT_REPEAT_MODE, type RepeatMode, type usePlayback } from '../playback/usePlayback'
import { MAP_CONTROLS_CLEARANCE, MapControls } from './MapControls'
import { MiniPlayer } from './MiniPlayer'
import { NowPlayingScreen } from './NowPlayingScreen'
import { PhoneCollections } from './PhoneCollections'
import { PhoneLibrary } from './PhoneLibrary'
import { PhonePages } from './PhonePages'
import { NodeBody, NodeControls, NodeHeader } from './PhoneNode'
import { SearchField, SearchResultsList } from './PhoneSearch'
import { Sheet } from './Sheet'
import { UpNextList } from './UpNextList'
import { UpNextTransport } from './UpNextTransport'
import {
  closeSheetView,
  popPhonePage,
  popPhonePageThen,
  popSheetOverlay,
  pushPhonePage,
  pushSheetOverlay,
  replaceOverlaysWithView,
  usePhonePages,
  useSheetOverlays,
  useSheetView,
} from './navigation'
import { NODE_CONTROLS_CLEARANCE, openPhoneNode, usePhoneNode } from './nodeDetail'
import { phonePlatform, phoneShellLayout } from './phoneLayout'
import { searchPeekLine, usePhoneSearch } from './searchState'
import { useSafeArea } from './safeArea'
import { SEARCH_TOP_GAP, dragOpensUpNext, type Detent, type DetentHeights } from './sheetGeometry'
import { OVERLAY_DETENT, overlayTransition, type Depth } from './sheetOverlays'
import { usePlayingFrom, usePlayingTrack } from './usePlayingTrack'

/* The phone layout (#389, Claude Design's Legato Mobile v2): the map edge to
 * edge as the ground, the search capsule and node-type chips floating over
 * it, and everything else in one glass sheet headed by the mini player.
 * App.tsx draws this instead of the desktop shell at phone width, from the
 * same state: the same queue, map, settings and search.
 *
 * The library and collections tabs are the handoff's own (PhoneLibrary,
 * PhoneCollections). Settings and Library health are pushed pages
 * (PhonePages.tsx).
 *
 * Up next is the handoff's screen 6: dragging the mini player up opens it
 * at large, and while it's open the header is the full transport in place
 * of the mini player. A tap on either's cover opens Now playing (screen 7)
 * over everything, as a pushed page of its own.
 *
 * Search and a node's detail are overlays the sheet shows in place of its
 * tabs (PhoneSearch.tsx, PhoneNode.tsx), kept in the history
 * (navigation.ts) so back walks back through them. Each takes the sheet's
 * header and covers its tabs, which stay where they were underneath; the
 * controls over the map change with them. The node on top of that history
 * is the map's selection, centred above the sheet as it opens. */

type Playback = ReturnType<typeof usePlayback>

export type SheetTab = 'library' | 'collections' | 'next'

const TABS = [
  { value: 'library', label: 'library' },
  { value: 'collections', label: 'collections' },
  { value: 'next', label: 'up next' },
] as const satisfies readonly { value: SheetTab; label: string }[]

const tabError = (error: Error, reset: () => void) => (
  <div className="p-[20px]">
    <RenderError title="This tab couldn't be drawn." error={error} action={<Button onClick={reset}>try again</Button>} />
  </div>
)

type PhoneShellProps = {
  /** The ground: the map, edge to edge. */
  stage: ReactNode
  /** First run's "Add your music", with no folder yet, in place of the map. */
  firstRun?: ReactNode
  playback: Playback
  /** The playing track's artist from the map's graph. */
  playingArtist: string | null
  canShuffle: boolean
  onShuffleLibrary: () => void
  /** Select a node and fly the map to it. */
  onFocusNode: (id: number) => void
  /** Select a node, or nothing, without moving the map. */
  onSelectNode: (id: number | null) => void
  /** Centre the map on a node above a sheet so tall (CanvasHandle). */
  onCentreNode: (id: number, options: { bottomInset: number; topInset?: number }) => void
  selectedNodeId: number | null
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  themePreference: ThemePreference
  onSetThemePreference: (preference: ThemePreference) => void
  /** ⌘K and / ask for search: the workspace's palette state, which the
   * phone answers by opening its own. */
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  unreachable: UnreachableView | null
}

export function PhoneShell({
  stage,
  firstRun,
  playback,
  playingArtist,
  canShuffle,
  onShuffleLibrary,
  onFocusNode,
  onSelectNode,
  onCentreNode,
  settings,
  updateSettings,
  themePreference,
  onSetThemePreference,
  searchOpen,
  onSearchOpenChange,
  unreachable,
}: PhoneShellProps) {
  // An overlay, or a view open in the collections tab, is in the history,
  // so after a reload the sheet opens on it, as a pushed page stays open.
  const overlays = useSheetOverlays()
  const overlay = overlays[overlays.length - 1] ?? null
  const sheetView = useSheetView()
  const [detent, setDetent] = useState<Detent>(() => (overlay ? OVERLAY_DETENT[overlay.kind] : sheetView ? 'large' : 'peek'))
  const [tab, setTab] = useState<SheetTab>(() => (sheetView ? 'collections' : 'library'))
  const [heights, setHeights] = useState<DetentHeights>({ peek: 0, medium: 0, large: 0 })
  const peekHeight = heights.peek
  const pages = usePhonePages()
  const platform = useMemo(() => phonePlatform(), [])

  // The detent the sheet goes to as its overlays change (sheetOverlays.ts).
  const [overlaysShown, setOverlaysShown] = useState(overlays)
  const [savedDetents, setSavedDetents] = useState<ReadonlyMap<Depth, Detent>>(new Map())
  if (overlaysShown !== overlays) {
    setOverlaysShown(overlays)
    const transition = overlayTransition(overlaysShown, overlays, detent, savedDetents)
    if (transition) {
      setSavedDetents(transition.saved)
      setDetent(transition.detent)
    }
  }
  const searching = overlays.some((o) => o.kind === 'search')
  const search = usePhoneSearch(searching)
  const nodeId = overlay?.kind === 'node' ? overlay.id : null
  const node = usePhoneNode(nodeId, playback)

  const track = usePlayingTrack(playback, playingArtist)
  const playingFrom = usePlayingFrom(playback, track.album)
  const repeatMode = (settings.repeatMode as RepeatMode) || 'off'
  const cycleRepeat = () => void updateSettings({ repeatMode: NEXT_REPEAT_MODE[repeatMode] })
  // Up next's full transport replaces the mini player above peek, where
  // the mini player heads the sheet: under no overlay.
  const upNextOpen = overlay == null && tab === 'next' && detent !== 'peek' && playback.currentTitle != null
  const coverColor = useCoverColor(upNextOpen ? track.nodeId : null)

  // Now playing stays mounted while it slides away.
  const nowPlayingOpen = pages[pages.length - 1] === 'now-playing'
  const [nowPlayingShown, setNowPlayingShown] = useState(nowPlayingOpen)
  if (nowPlayingOpen && !nowPlayingShown) setNowPlayingShown(true)
  const openNowPlaying = useCallback(() => pushPhonePage('now-playing'), [])
  // With nothing playing there's nothing to show: a reload, or the queue
  // running out.
  const nothingPlaying = playback.currentTitle == null
  useEffect(() => {
    if (nowPlayingOpen && nothingPlaying) popPhonePage()
  }, [nowPlayingOpen, nothingPlaying])

  const safe = useSafeArea()
  const windowSize = useWindowSize()
  const mapTop = safe.top + (overlay?.kind === 'node' ? NODE_CONTROLS_CLEARANCE : MAP_CONTROLS_CLEARANCE)
  const layout = useMemo(() => phoneShellLayout(windowSize.width, windowSize.height, peekHeight, mapTop), [windowSize, peekHeight, mapTop])

  // The controls over the map fade as the sheet comes up to large, with
  // the dim, written as the sheet moves rather than rendered.
  const controlsRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const onExpansion = useCallback((progress: number, animate: boolean) => {
    for (const controls of [controlsRef.current, pillRef.current]) {
      if (!controls) continue
      controls.style.transition = animate ? 'opacity var(--motion-spring) var(--ease-out)' : 'none'
      controls.style.opacity = String(1 - progress)
    }
  }, [])

  // The node on top is the map's selection, centred above the sheet: at
  // medium as it opens, or lower if the sheet is. Going back from the last
  // one selects nothing. A node opened from anywhere arrives the same way.
  const centre = useCallback(
    (id: number) => {
      const bottomInset = Math.min(heights[detent], heights.medium)
      if (bottomInset > 0) onCentreNode(id, { bottomInset, topInset: safe.top + NODE_CONTROLS_CLEARANCE })
    },
    [heights, detent, safe.top, onCentreNode],
  )
  const centreRef = useRef(centre)
  centreRef.current = centre
  const selectedRef = useRef<number | null>(null)
  useEffect(() => {
    if (nodeId == null && selectedRef.current == null) return
    selectedRef.current = nodeId
    onSelectNode(nodeId)
    if (nodeId != null) centreRef.current(nodeId)
  }, [nodeId, heights.medium, onSelectNode])

  // ⌘K or / on a phone with a keyboard opens the phone's search.
  useEffect(() => {
    if (!searchOpen) return
    pushSheetOverlay({ kind: 'search' })
    onSearchOpenChange(false)
  }, [searchOpen, onSearchOpenChange])

  // Escape goes back from an overlay, as back does. A field and a popover
  // answer their own.
  const hasOverlay = overlay != null
  useEffect(() => {
    if (!hasOverlay) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      popSheetOverlay()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [hasOverlay])

  // The search field takes the focus in the tap that opens it, so a phone
  // brings its keyboard up: iOS only does that for a focus inside the tap.
  const openSearch = () => flushSync(() => pushSheetOverlay({ kind: 'search' }))
  const openNode = (id: number) => openPhoneNode(id)
  const openFromSheet = (id: number) => openPhoneNode(id, { push: true })

  // A playlist from search opens in the collections tab, at large, in
  // search's place, so back from it goes where back from search would have.
  const openPlaylist = (playlistId: number) => {
    setTab('collections')
    setSavedDetents((saved) => new Map(saved).set(-1, 'large'))
    replaceOverlaysWithView({ kind: 'playlist', playlistId })
  }
  const openSearchResult = (item: { kind: string; id: number }) =>
    item.kind === 'playlist' ? openPlaylist(item.id) : openFromSheet(item.id)

  // "Show on map" shows the map: the sheet goes down to peek.
  const showOnMap = useCallback(
    (id: number) => {
      setDetent('peek')
      onFocusNode(id)
    },
    [onFocusNode],
  )

  // Leaving the collections tab leaves whatever was open in it, so the
  // system back never closes something out of sight.
  const changeTab = (next: SheetTab) => {
    if (next !== 'collections') closeSheetView()
    setTab(next)
  }

  // Dragging the mini player up opens up next, at large: the handoff's
  // screen 6. A drag anywhere else in the sheet keeps its tab.
  const miniPlayerRef = useRef<HTMLDivElement>(null)
  const onDetentChange = (next: Detent, origin?: Element | null) => {
    const fromMiniPlayer = origin != null && miniPlayerRef.current?.contains(origin) === true
    if (dragOpensUpNext({ current: detent, next, fromMiniPlayer })) {
      changeTab('next')
      setDetent('large')
      return
    }
    setDetent(next)
  }

  const stats = useLibraryStats(useLibraryChanges())

  // An album, an artist or a person opens its detail over the tab, and back
  // comes back to the tab as it was.
  const content: Record<SheetTab, ReactNode> = {
    library: <PhoneLibrary onOpenNode={openNode} playback={playback} noLibrary={firstRun != null} onShowMap={() => setDetent('peek')} />,
    collections: <PhoneCollections onOpenNode={openNode} playback={playback} />,
    next: (
      <ErrorBoundary fallback={tabError}>
        <UpNextList playback={playback} from={playingFrom} onShuffleLibrary={onShuffleLibrary} />
      </ErrorBoundary>
    ),
  }

  return (
    <ShellLayoutContext.Provider value={layout}>
      <AppShell>
        {/* Under a pushed page, the map and the sheet are out of reach. */}
        <div className="absolute inset-0" data-phone-shell inert={pages.length > 0}>
          {stage}
          {/* Between the controls over the map and the sheet at peek, so
           * nothing of it starts under either. */}
          {firstRun != null && (
            <div className="absolute inset-x-0" style={{ top: mapTop, bottom: peekHeight }}>
              {firstRun}
            </div>
          )}
          {overlay == null && (
            <MapControls
              ref={controlsRef}
              settings={settings}
              updateSettings={updateSettings}
              onOpenSearch={openSearch}
              onOpenSettings={() => pushPhonePage('settings')}
              hidden={detent === 'large'}
            />
          )}
          {overlay?.kind === 'node' && (
            <NodeControls onBack={popSheetOverlay} onCentre={() => centre(overlay.id)} pillRef={pillRef} pillHidden={detent === 'large'} />
          )}
          {overlay?.kind === 'search' && (
            <SearchField search={search} onCancel={popSheetOverlay} onSubmit={() => search.top && openSearchResult(search.top)} />
          )}
          {/* Over the map, under the sheet, so whatever's buffered can
           * still be paused (#119). */}
          {unreachable && <ServerUnreachableOverShell view={unreachable} />}
          <Sheet
            label={
              overlay?.kind === 'search'
                ? 'Search results'
                : overlay?.kind === 'node'
                  ? (node.details?.node.title ?? 'Details')
                  : 'Library and player'
            }
            detent={detent}
            onDetentChange={onDetentChange}
            onExpansion={onExpansion}
            onHeightsChange={setHeights}
            largeTopGap={overlay?.kind === 'search' ? SEARCH_TOP_GAP : undefined}
            dim={overlay?.kind !== 'search'}
            overlayKey={overlay?.kind === 'node' ? `node:${overlay.id}` : overlay?.kind}
            // The cover's colour over the top 300px, as the handoff's up
            // next frame draws it.
            wash={upNextOpen && coverColor ? `linear-gradient(180deg, ${withAlpha(coverColor, 0.38)} 0%, transparent 300px)` : undefined}
            overlay={
              overlay?.kind === 'search' ? (
                <SearchResultsList
                  search={search}
                  playback={playback}
                  onOpenNode={openFromSheet}
                  onOpenPlaylist={openPlaylist}
                  onPlayed={popSheetOverlay}
                />
              ) : overlay?.kind === 'node' ? (
                <NodeBody node={node} playback={playback} onOpenNode={openFromSheet} />
              ) : undefined
            }
            header={
              overlay?.kind === 'node' ? (
                <NodeHeader node={node} playback={playback} onOpenNode={openFromSheet} />
              ) : overlay?.kind === 'search' ? null : (
                <>
                  {upNextOpen ? (
                    <UpNextTransport
                      playback={playback}
                      track={track}
                      repeatMode={repeatMode}
                      onCycleRepeat={cycleRepeat}
                      onOpenNowPlaying={openNowPlaying}
                    />
                  ) : (
                    <div ref={miniPlayerRef}>
                      <MiniPlayer
                        playback={playback}
                        artist={playingArtist}
                        compact={detent === 'large'}
                        canShuffle={canShuffle}
                        onShuffleLibrary={onShuffleLibrary}
                        onOpenNowPlaying={openNowPlaying}
                      />
                    </div>
                  )}
                  {/* Under up next's transport the tabs sit inside its 20px
                   * margins, hairline and all. */}
                  <div className={`border-b border-[var(--color-line)] ${upNextOpen ? 'mx-[20px] mt-[10px]' : 'mt-[6px] px-[20px]'}`}>
                    <Tabs label="sheet" variant="underline" size="lg" options={TABS} value={tab} onChange={changeTab} />
                  </div>
                </>
              )
            }
            peek={
              overlay?.kind === 'node' ? undefined : overlay?.kind === 'search' ? (
                <div className="px-[20px] pt-[4px] pb-[4px]">
                  <span className="block truncate text-secondary text-[var(--color-ink-2)]">{searchPeekLine(search)}</span>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-[12px] px-[20px] pt-[12px] pb-[4px]">
                  <span className="truncate text-secondary text-[var(--color-ink-2)]">
                    {stats && stats.albums > 0 ? `Swipe up for ${plural(stats.albums, 'album')}` : 'Swipe up for your library'}
                  </span>
                  {stats != null && stats.tracks > 0 && (
                    <span className="mono shrink-0 text-mono text-[var(--color-ink-3)]">{plural(stats.tracks, 'track')}</span>
                  )}
                </div>
              )
            }
          >
            <div role="tabpanel" aria-label={TABS.find((t) => t.value === tab)?.label} className="h-full">
              {content[tab]}
            </div>
          </Sheet>
        </div>

        <PhonePages
          platform={platform}
          settings={settings}
          updateSettings={updateSettings}
          themePreference={themePreference}
          onSetThemePreference={onSetThemePreference}
          onShowOnMap={showOnMap}
        />

        {/* Each way out closes it first, a back in the history, and only
         * then goes on: opening a node adds an entry of its own. */}
        {nowPlayingShown && (
          <NowPlayingScreen
            open={nowPlayingOpen}
            onClose={popPhonePage}
            onClosed={() => setNowPlayingShown(false)}
            playback={playback}
            track={track}
            from={playingFrom}
            platform={platform}
            repeatMode={repeatMode}
            onCycleRepeat={cycleRepeat}
            onShowOnMap={(id) => popPhonePageThen(() => showOnMap(id))}
            onOpenNode={(id) => popPhonePageThen(() => openPhoneNode(id))}
            onOpenUpNext={() =>
              popPhonePageThen(() => {
                changeTab('next')
                setDetent('large')
              })
            }
          />
        )}
      </AppShell>
    </ShellLayoutContext.Provider>
  )
}
