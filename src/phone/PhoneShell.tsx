import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppShell } from '../shell/AppShell'
import { ShellLayoutContext, useWindowSize } from '../shell/layout'
import type { LeftView, NowPlayingTab } from '../shell/panels'
import { Button } from '../ui/Button'
import { ErrorBoundary, RenderError } from '../ui/ErrorBoundary'
import { Icon } from '../ui/Icon'
import { Tabs } from '../ui/Tabs'
import { plural } from '../ui/format'
import { LibraryView } from '../library/LibraryView'
import { useLibraryChanges, useLibraryStats } from '../library/useLibraryChanges'
import { CollectionsPanel } from '../panels/CollectionsPanel'
import { HealthPanel } from '../panels/HealthPanel'
import { NowPlaying } from '../panels/NowPlaying'
import { SettingsPanel } from '../panels/SettingsPanel'
import { SearchPalette } from '../search/SearchPalette'
import { ServerUnreachableOverShell, type UnreachableView } from '../connect/ServerUnreachable'
import type { Settings } from '../hooks/useSettings'
import type { ThemePreference } from '../hooks/useTheme'
import type { usePlayback } from '../playback/usePlayback'
import { MAP_CONTROLS_CLEARANCE, MapControls } from './MapControls'
import { MiniPlayer } from './MiniPlayer'
import { PhonePages } from './PhonePages'
import { Sheet } from './Sheet'
import { pushPhonePage, usePhonePages } from './navigation'
import { phonePlatform, phoneShellLayout } from './phoneLayout'
import { useSafeArea } from './safeArea'
import type { Detent, DetentHeights } from './sheetGeometry'

/* The phone layout (#389, Claude Design's Legato Mobile v2): the map edge to
 * edge as the ground, the search capsule and node-type chips floating over
 * it, and everything else in one glass sheet headed by the mini player.
 * App.tsx draws this instead of the desktop shell at phone width, from the
 * same state: the same queue, map, settings and search.
 *
 * The sheet's tabs show the desktop's own library view, collections panel
 * and now playing for now; later steps of #389 draw them as the handoff
 * does, and add node detail, search, now playing and the pushed pages'
 * own content. */

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
  selectedNodeId: number | null
  settings: Settings
  updateSettings: (partial: Settings) => Promise<void>
  themePreference: ThemePreference
  onSetThemePreference: (preference: ThemePreference) => void
  /** The search palette's state is the workspace's: ⌘K and / open it. */
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
  selectedNodeId,
  settings,
  updateSettings,
  themePreference,
  onSetThemePreference,
  searchOpen,
  onSearchOpenChange,
  unreachable,
}: PhoneShellProps) {
  const [detent, setDetent] = useState<Detent>('peek')
  const [tab, setTab] = useState<SheetTab>('library')
  const [collectionsView, setCollectionsView] = useState<LeftView>({ kind: 'collections' })
  const [healthView, setHealthView] = useState<LeftView>({ kind: 'health' })
  const [nowPlayingTab, setNowPlayingTab] = useState<NowPlayingTab>('next')
  const [peekHeight, setPeekHeight] = useState(0)
  const pages = usePhonePages()
  const platform = useMemo(() => phonePlatform(), [])

  const windowSize = useWindowSize()
  const mapTop = useSafeArea().top + MAP_CONTROLS_CLEARANCE
  const layout = useMemo(
    () => phoneShellLayout(windowSize.width, windowSize.height, peekHeight, mapTop),
    [windowSize, peekHeight, mapTop],
  )
  const onHeightsChange = useCallback((heights: DetentHeights) => setPeekHeight(heights.peek), [])

  // The controls over the map fade as the sheet comes up to large, with
  // the dim, written as the sheet moves rather than rendered.
  const controlsRef = useRef<HTMLDivElement>(null)
  const onExpansion = useCallback((progress: number, animate: boolean) => {
    const controls = controlsRef.current
    if (!controls) return
    controls.style.transition = animate ? 'opacity var(--motion-spring) var(--ease-out)' : 'none'
    controls.style.opacity = String(1 - progress)
  }, [])

  // Anything opened on the map shows the map: the sheet goes down to peek.
  const showOnMap = useCallback(
    (id: number) => {
      setDetent('peek')
      onFocusNode(id)
    },
    [onFocusNode],
  )

  const stats = useLibraryStats(useLibraryChanges())

  const content: Record<SheetTab, ReactNode> = {
    library: (
      <LibraryView
        selectedNodeId={selectedNodeId}
        onOpenNode={showOnMap}
        playback={playback}
        settings={settings}
        updateSettings={updateSettings}
      />
    ),
    collections: (
      <div className="px-[20px] pt-[14px] pb-[20px]">
        <CollectionsPanel
          view={collectionsView}
          onNavigate={(view) => setCollectionsView(view ?? { kind: 'collections' })}
          onFocusNode={showOnMap}
          playback={playback}
        />
      </div>
    ),
    next: (
      <div className="p-[12px]">
        <ErrorBoundary key={playback.status.currentRecordingNodeId} fallback={tabError}>
          <NowPlaying
            nodeId={playback.status.currentRecordingNodeId}
            tab={nowPlayingTab}
            onTabChange={setNowPlayingTab}
            playback={playback}
            onFocusNode={showOnMap}
            onOpenDetails={showOnMap}
            onShuffleLibrary={onShuffleLibrary}
            onShowOnMap={showOnMap}
          />
        </ErrorBoundary>
      </div>
    ),
  }

  const pageContent = {
    settings: (
      <div className="flex flex-col gap-[16px]">
        {/* Where the handoff's settings page puts it: Library health
         * pushes from Settings. */}
        <button
          type="button"
          onClick={() => pushPhonePage('health')}
          className="flex min-h-[52px] items-center justify-between rounded-[16px] border border-[var(--color-line)] bg-[var(--color-solid)] px-[16px] text-[length:var(--text-heading)] text-[var(--color-ink)]"
        >
          Library health
          <span className="inline-flex -rotate-90 text-[var(--color-ink-3)]">
            <Icon name="chevron-down" size={18} />
          </span>
        </button>
        <SettingsPanel
          settings={settings}
          updateSettings={updateSettings}
          onSetAudioDevice={playback.setAudioDevice}
          themePreference={themePreference}
          onSetThemePreference={onSetThemePreference}
        />
      </div>
    ),
    health: <HealthPanel view={healthView} onNavigate={(view) => setHealthView(view ?? { kind: 'health' })} onFocusNode={showOnMap} />,
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
          <MapControls
            ref={controlsRef}
            settings={settings}
            updateSettings={updateSettings}
            onOpenSearch={() => onSearchOpenChange(true)}
            onOpenSettings={() => pushPhonePage('settings')}
            hidden={detent === 'large'}
          />
          {/* Over the map, under the sheet, so whatever's buffered can
           * still be paused (#119). */}
          {unreachable && <ServerUnreachableOverShell view={unreachable} />}
          <Sheet
            label="Library and player"
            detent={detent}
            onDetentChange={setDetent}
            onExpansion={onExpansion}
            onHeightsChange={onHeightsChange}
            header={
              <>
                <MiniPlayer
                  playback={playback}
                  artist={playingArtist}
                  compact={detent === 'large'}
                  canShuffle={canShuffle}
                  onShuffleLibrary={onShuffleLibrary}
                />
                <div className="mt-[6px] border-b border-[var(--color-line)] px-[20px]">
                  <Tabs label="sheet" variant="underline" size="lg" options={TABS} value={tab} onChange={setTab} />
                </div>
              </>
            }
            peek={
              <div className="flex items-center justify-between gap-[12px] px-[20px] pt-[12px] pb-[4px]">
                <span className="truncate text-secondary text-[var(--color-ink-2)]">
                  {stats && stats.albums > 0 ? `Swipe up for ${plural(stats.albums, 'album')}` : 'Swipe up for your library'}
                </span>
                {stats != null && stats.tracks > 0 && (
                  <span className="mono shrink-0 text-mono text-[var(--color-ink-3)]">{plural(stats.tracks, 'track')}</span>
                )}
              </div>
            }
          >
            <div role="tabpanel" aria-label={TABS.find((t) => t.value === tab)?.label} className="h-full">
              {content[tab]}
            </div>
          </Sheet>
        </div>

        <PhonePages platform={platform} content={pageContent} />

        {searchOpen && (
          <SearchPalette
            onClose={() => onSearchOpenChange(false)}
            onOpen={(id) => {
              onSearchOpenChange(false)
              showOnMap(id)
            }}
            onOpenPlaylist={(playlistId) => {
              onSearchOpenChange(false)
              setCollectionsView({ kind: 'playlist', playlistId })
              setTab('collections')
              setDetent('large')
            }}
            playback={playback}
          />
        )}
      </AppShell>
    </ShellLayoutContext.Provider>
  )
}
