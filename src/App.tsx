import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Centered } from './shell/Centered'
import { useServerReady } from './hooks/useServerReady'
import { ServerUpdateNotice } from './shell/ServerUpdateNotice'
import { ToastProvider } from './ui/Toast'
import { useWsEvent } from './hooks/useWs'
import Canvas, { type CanvasHandle } from './canvas/Canvas'
import { GraphDataProvider } from './canvas/graphData'
import { useGraph } from './canvas/graphContext'
import { resolveEdgeColorOverrides } from './canvas/edgeTypes'
import { resolveNodeSizeMultipliers } from './canvas/nodeTypes'
import { usePlayback } from './playback/usePlayback'
import { AppShell } from './shell/AppShell'
import { Rail } from './shell/Rail'
import { Capsule, type ViewMode } from './shell/Capsule'
import { IdlePlayer, Player } from './shell/Player'
import { LeftPanel, RightPanel } from './shell/SidePanel'
import { ShellLayoutContext, computeShellLayout, useWindowSize } from './shell/layout'
import { railOwner, type DetailsTab, type LeftView, type NowPlayingTab, type RailItem, type RightView } from './shell/panels'
import { MapOptions } from './panels/MapOptions'
import { CollectionsPanel } from './panels/CollectionsPanel'
import { HealthPanel } from './panels/HealthPanel'
import { SettingsPanel } from './panels/SettingsPanel'
import { NowPlaying } from './panels/NowPlaying'
import { NodeDetails } from './panels/NodeDetails'
import { SearchPalette } from './search/SearchPalette'
import { API_BASE } from './config/serverHost'
import { useSettings } from './hooks/useSettings'
import { useTheme, type ResolvedTheme, type ThemePreference } from './hooks/useTheme'
import { useMapPresetHistory } from './hooks/useMapPresetHistory'
import type { ReplayGainMode, RepeatMode } from './playback/usePlayback'
import { LibraryView } from './library/LibraryView'
import { AddMusic } from './library/AddMusic'
import { useAuth } from './auth/useAuth'
import { OwnerGate } from './auth/OwnerGate'
import { AccountContext, initialsFor, useAccount } from './auth/accountContext'
import { Button } from './ui/Button'
import { useCoverColor, withAlpha } from './ui/coverColor'
import { LAUNCHED_OFFLINE } from './pwa/register'
import { useInstallOffer } from './pwa/installOffer'

// #125: off -> all -> one -> off. The player's single repeat button cycles
// through this rather than exposing three separate controls.
const NEXT_REPEAT_MODE: Record<RepeatMode, RepeatMode> = {
  off: 'all',
  all: 'one',
  one: 'off',
}

/* "Shuffle library" queues this many tracks at most. The whole library would
 * mean resolving thousands of files before the first note; a few hundred is
 * hours of music and resolves at once. */
const SHUFFLE_LIBRARY_SIZE = 500

const PANEL_LABEL: Record<RailItem, string> = {
  collections: 'Collections',
  health: 'Library health',
  settings: 'Settings',
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName)) return true
  return (el as HTMLElement).isContentEditable
}

// The shell is the front door, first run included: with no music folder
// yet, its stage asks for one.
function MainApp() {
  // #136: per-device theme, applied (and kept applied) by the hook itself.
  // resolvedTheme threads down only to the places that swap a whole asset
  // (the logo) or have to repaint WebGL (the map).
  const theme = useTheme()
  const [hasLibrary, setHasLibrary] = useState<boolean | null>(null)

  useEffect(() => {
    fetch(`${API_BASE}/library-roots`)
      .then((r) => r.json())
      .then((roots: unknown[]) => setHasLibrary(roots.length > 0))
  }, [])

  if (hasLibrary === null) return <Centered>loading library…</Centered>

  return (
    <GraphDataProvider>
      <Workspace
        hasLibrary={hasLibrary}
        onLibraryAdded={() => setHasLibrary(true)}
        resolvedTheme={theme.resolvedTheme}
        themePreference={theme.preference}
        onSetThemePreference={theme.setPreference}
      />
    </GraphDataProvider>
  )
}

/* Everything on screen once there's a library: the stage (map or library),
 * and the shell floating over it — rail, capsule, the two side panels, the
 * player and the search palette. This owns which of those are open; each
 * one owns what's inside it. */
function Workspace({
  hasLibrary,
  onLibraryAdded,
  resolvedTheme,
  themePreference,
  onSetThemePreference,
}: {
  hasLibrary: boolean
  onLibraryAdded: () => void
  resolvedTheme: ResolvedTheme
  themePreference: ThemePreference
  onSetThemePreference: (preference: ThemePreference) => void
}) {
  const graph = useGraph()
  const account = useAccount()
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null)
  const [leftView, setLeftView] = useState<LeftView | null>(null)
  const [rightView, setRightView] = useState<RightView | null>(null)
  const [nowPlayingTab, setNowPlayingTab] = useState<NowPlayingTab>('next')
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('overview')
  const [searchOpen, setSearchOpen] = useState(false)
  const { settings, updateSettings } = useSettings()
  // #127: held here rather than inside the map options popover, which
  // unmounts whenever it closes; its undo also answers Cmd/Ctrl+Z below.
  const mapPresets = useMapPresetHistory(settings, updateSettings)
  // #126: the map/library switch persists like every other settings toggle.
  const viewMode = (settings.viewMode as ViewMode) || 'map'
  const replaygainMode = (settings.replaygainMode as ReplayGainMode) || 'track'
  // #125: repeat is a persisted player setting; shuffle is per-queue and
  // lives inside usePlayback.
  const repeatMode = (settings.repeatMode as RepeatMode) || 'off'
  const playback = usePlayback(replaygainMode, repeatMode)
  // #128: the install offer, shown once after the first track plays.
  useInstallOffer()
  const canvasRef = useRef<CanvasHandle>(null)

  const windowSize = useWindowSize()
  const playerVisible = playback.currentTitle != null
  const layout = useMemo(
    () =>
      computeShellLayout(windowSize.width, windowSize.height, {
        leftOpen: leftView != null,
        rightOpen: rightView != null,
        playerVisible,
      }),
    [windowSize.width, windowSize.height, leftView, rightView, playerVisible],
  )

  // #46 "rebuild map": the server reseeds every node; a full Canvas remount
  // is the simplest way to show it, since the live graph sync deliberately
  // never moves a node it already tracks.
  const [rebuildEpoch, setRebuildEpoch] = useState(0)
  useWsEvent(['layout:rebuilt'], () => setRebuildEpoch((e) => e + 1))

  const dimOnHoverEnabled = settings.hoverDimEnabled !== 'false'
  const reducedMotionForced = settings.reducedMotionForced === 'true'

  // CSS motion has no access to a React setting, so the force-on override
  // is mirrored onto the root element for index.css to match against.
  useEffect(() => {
    if (reducedMotionForced) document.documentElement.dataset.reducedMotion = 'true'
    else delete document.documentElement.dataset.reducedMotion
  }, [reducedMotionForced])

  // Map options — read live by Canvas's reducers. Memoised so their
  // identity only changes when the settings they come from do.
  const edgeThicknessMultiplier = Number(settings.edgeThicknessMultiplier ?? '1')
  const showArtists = settings.showArtists !== 'false'
  const showReleases = settings.showReleases !== 'false'
  const showTracks = settings.showTracks !== 'false'
  // Producer/engineer credits are opt-in (#24): new to an already-tuned map.
  const showCreditNodes = settings.showCreditNodes === 'true'
  const showArtistLabels = settings.showArtistLabels !== 'false'
  const colourEdgesByType = settings.colourEdgesByType === 'true'
  const edgeColorOverrides = useMemo(() => resolveEdgeColorOverrides(settings), [settings])
  const nodeSizeMultipliers = useMemo(() => resolveNodeSizeMultipliers(settings), [settings])
  const nodesLocked = settings.nodePositionsLocked === 'true'
  const forceCenterStrength = Number(settings.forceCenterStrength ?? '0.03')
  const forceRepelStrength = Number(settings.forceRepelStrength ?? '150')
  const forceLinkStrength = Number(settings.forceLinkStrength ?? '0.15')
  const linkDistance = Number(settings.linkDistance ?? '80')

  // A saved output device is applied on launch and on any change; Rust
  // falls back to the default device if the saved one is gone.
  useEffect(() => {
    if (settings.audioDevice) void playback.setAudioDevice(settings.audioDevice)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.audioDevice])

  const playingNodeId = playback.status.currentRecordingNodeId
  const playingArtist = playingNodeId != null ? (graph.byId.get(playingNodeId)?.subtitle ?? null) : null

  const shuffleLibrary = useCallback(() => {
    const ids = graph.nodes.filter((n) => n.type === 'recording').map((n) => n.id)
    if (ids.length === 0) return
    void playback.playTracks(shuffled(ids).slice(0, SHUFFLE_LIBRARY_SIZE), 0, '')
  }, [graph.nodes, playback])

  const openDetails = useCallback((id: number, tab: DetailsTab = 'overview') => {
    setSelectedNodeId(id)
    setDetailsTab(tab)
    setRightView('details')
  }, [])

  // Every "go to this" in the app — a search result, a connection chip, a
  // worklist row — lands here. On the map that means select and fly, and
  // the card does the rest; in the library there's no card to show, so the
  // details panel opens instead.
  const focusNode = useCallback(
    (id: number) => {
      if (viewMode === 'map') {
        setSelectedNodeId(id)
        canvasRef.current?.flyToNode(id)
      } else {
        openDetails(id)
      }
    },
    [viewMode, openDetails],
  )

  const toggleRail = (item: RailItem) => setLeftView((current) => (railOwner(current) === item ? null : { kind: item }))
  const toggleQueue = () => {
    setRightView((current) => (current === 'queue' ? null : 'queue'))
    setNowPlayingTab('next')
  }

  const selectNode = (id: number | null) => {
    setSelectedNodeId(id)
    // The details panel is a view of the selection; with nothing selected
    // there's nothing behind it.
    if (id == null) setRightView((current) => (current === 'details' ? null : current))
  }

  // Escape unwinds one layer at a time: the right panel, then the
  // selection, then the left panel. The search palette and dialogs own
  // their own Escape and stop it before it gets here.
  const escapeRef = useRef<() => void>(() => {})
  escapeRef.current = () => {
    if (rightView != null) setRightView(null)
    else if (selectedNodeId != null) setSelectedNodeId(null)
    else if (leftView != null) setLeftView(null)
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // ⌘K / Ctrl-K opens search from anywhere, mid-typing included — it's
      // the one shortcut whose whole point is not having to go find a field.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
        return
      }
      if (searchOpen || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return

      // #127: the map's session undo. Yields to real text editing only —
      // a focused button must not swallow "click a preset, Cmd+Z it".
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        const el = document.activeElement as HTMLElement | null
        const editingText = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true
        if (!editingText) {
          e.preventDefault()
          mapPresets.undo()
        }
        return
      }

      if (e.key === 'Escape') {
        if (document.activeElement && isTypingTarget(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return
        escapeRef.current()
        return
      }

      if (isTypingTarget(document.activeElement)) return

      if (e.code === 'Space') {
        e.preventDefault()
        if (playback.currentTitle == null) {
          shuffleLibrary()
          return
        }
        if (playback.status.playing) playback.pause()
        else playback.resume()
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [searchOpen, playback, mapPresets, shuffleLibrary])

  // The right panel's wash: the playing cover for now playing, the
  // selected node's for details. Fades out down the panel so the content
  // below the header sits on plain glass.
  const rightNodeId = rightView === 'details' ? selectedNodeId : playingNodeId
  const rightColor = useCoverColor(rightView != null ? rightNodeId : null)
  const rightWash =
    rightColor == null
      ? undefined
      : rightView === 'details'
        ? `linear-gradient(180deg, ${withAlpha(rightColor, 0.22)}, ${withAlpha(rightColor, 0)} 420px)`
        : `linear-gradient(180deg, ${withAlpha(rightColor, 0.42)}, ${withAlpha(rightColor, 0.12)} 340px, ${withAlpha(rightColor, 0)} 520px)`

  const owner = railOwner(leftView)
  const leftContent = (() => {
    if (leftView == null) return null
    switch (leftView.kind) {
      case 'collections':
      case 'playlist':
      case 'import':
        return <CollectionsPanel view={leftView} onNavigate={setLeftView} onFocusNode={focusNode} playback={playback} />
      case 'health':
      case 'worklist':
        return <HealthPanel view={leftView} onNavigate={setLeftView} onFocusNode={focusNode} />
      case 'settings':
        return (
          <SettingsPanel
            settings={settings}
            updateSettings={updateSettings}
            onSetAudioDevice={playback.setAudioDevice}
            themePreference={themePreference}
            onSetThemePreference={onSetThemePreference}
          />
        )
    }
  })()

  const mapOptions = <MapOptions settings={settings} updateSettings={updateSettings} mapPresets={mapPresets} />

  return (
    <ShellLayoutContext.Provider value={layout}>
      <AppShell>
        {!hasLibrary ? (
          <div className="absolute inset-y-0" style={{ left: layout.leftOccupancy, right: layout.rightOccupancy }}>
            <AddMusic
              onAdded={() => {
                onLibraryAdded()
                // The first scan is drawn on the map as it runs.
                void updateSettings({ viewMode: 'map' })
              }}
            />
          </div>
        ) : viewMode === 'map' ? (
          <Canvas
            key={rebuildEpoch}
            ref={canvasRef}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            onOpenDetails={() => selectedNodeId != null && openDetails(selectedNodeId)}
            playback={playback}
            dimOnHoverEnabled={dimOnHoverEnabled}
            reducedMotionForced={reducedMotionForced}
            showArtists={showArtists}
            showReleases={showReleases}
            showTracks={showTracks}
            showCreditNodes={showCreditNodes}
            showArtistLabels={showArtistLabels}
            colourEdgesByType={colourEdgesByType}
            nodeSizeMultipliers={nodeSizeMultipliers}
            edgeThicknessMultiplier={edgeThicknessMultiplier}
            edgeColorOverrides={edgeColorOverrides}
            nodesLocked={nodesLocked}
            forceCenterStrength={forceCenterStrength}
            forceRepelStrength={forceRepelStrength}
            forceLinkStrength={forceLinkStrength}
            linkDistance={linkDistance}
            onRestoreDefaults={mapPresets.restoreDefaults}
            mapOptions={mapOptions}
            theme={resolvedTheme}
          />
        ) : (
          <LibraryView
            selectedNodeId={selectedNodeId}
            onOpenNode={openDetails}
            playback={playback}
            settings={settings}
            updateSettings={updateSettings}
          />
        )}

        <Rail
          active={owner}
          onToggle={toggleRail}
          theme={resolvedTheme}
          initials={initialsFor(account)}
          accountLabel={account?.displayName ?? account?.email ?? 'Account'}
        />
        {leftView != null && owner != null && <LeftPanel label={PANEL_LABEL[owner]}>{leftContent}</LeftPanel>}

        <Capsule
          view={viewMode}
          onViewChange={(mode) => void updateSettings({ viewMode: mode })}
          onOpenSearch={() => setSearchOpen(true)}
          hidden={searchOpen}
        />

        {rightView === 'queue' && (
          <RightPanel label="Now playing" wash={rightWash}>
            <NowPlaying
              nodeId={playingNodeId}
              tab={nowPlayingTab}
              onTabChange={setNowPlayingTab}
              playback={playback}
              onFocusNode={focusNode}
              onOpenDetails={openDetails}
              onShuffleLibrary={shuffleLibrary}
              onShowOnMap={(id) => {
                if (viewMode !== 'map') void updateSettings({ viewMode: 'map' })
                setSelectedNodeId(id)
                canvasRef.current?.flyToNode(id)
              }}
            />
          </RightPanel>
        )}
        {rightView === 'details' && selectedNodeId != null && (
          <RightPanel label="Details" wash={rightWash}>
            <NodeDetails
              key={selectedNodeId}
              nodeId={selectedNodeId}
              tab={detailsTab}
              onTabChange={setDetailsTab}
              playback={playback}
              onFocusNode={focusNode}
            />
          </RightPanel>
        )}

        {playerVisible ? (
          <Player
            title={playback.currentTitle ?? ''}
            artist={playingArtist}
            status={playback.status}
            shuffled={playback.shuffled}
            queueBusy={playback.queueBusy}
            repeatMode={repeatMode}
            problem={playback.problem}
            queueOpen={rightView === 'queue'}
            onToggleQueue={toggleQueue}
            onResolveProblem={() => void playback.resolveProblem()}
            onPause={playback.pause}
            onResume={playback.resume}
            onSeek={playback.seek}
            onSetVolume={playback.setVolume}
            onNext={playback.next}
            onPrevious={playback.previous}
            onToggleShuffle={playback.toggleShuffle}
            onCycleRepeat={() => void updateSettings({ repeatMode: NEXT_REPEAT_MODE[repeatMode] })}
          />
        ) : (
          // Hidden while the map is still empty: there's nothing to
          // shuffle yet, and the first-scan card owns the bottom of the
          // screen's attention.
          graph.nodes.some((n) => n.type === 'recording') && <IdlePlayer onShuffleLibrary={shuffleLibrary} busy={playback.queueBusy} />
        )}

        {searchOpen && (
          <SearchPalette
            onClose={() => setSearchOpen(false)}
            onOpen={(id) => {
              setSearchOpen(false)
              focusNode(id)
            }}
            onOpenPlaylist={(playlistId) => {
              setSearchOpen(false)
              setLeftView({ kind: 'playlist', playlistId })
            }}
            playback={playback}
          />
        )}
      </AppShell>
    </ShellLayoutContext.Provider>
  )
}

export default function App() {
  const { ready, everConnected, server } = useServerReady()

  if (!ready) {
    // #128: an installed web app launched with the server out of reach
    // runs the service worker's cached shell, and "starting" would be a
    // lie there: no browser starts a server. It still polls, so the app
    // comes up by itself once the server answers.
    const waiting = everConnected
      ? 'lost connection to legato-server…'
      : LAUNCHED_OFFLINE
        ? "can't reach legato-server…"
        : 'starting legato-server…'
    return <Centered>{waiting}</Centered>
  }

  const app = <MainApp />
  return (
    <ToastProvider>
      {/* A server older than migration 0029 has no owner gate and no
       * /auth/status to ask, so it runs ungated exactly as before,
       * with the notice saying to update it. */}
      {server?.outOfDate ? app : <OwnerGated>{app}</OwnerGated>}
      <ServerUpdateNotice server={server} />
    </ToastProvider>
  )
}

// Issue #112: nothing past this point renders until the server has an
// owner and this client holds a session for them.
function OwnerGated({ children }: { children: ReactNode }) {
  const { state, refresh, acceptSession } = useAuth()
  const { resolvedTheme } = useTheme()

  switch (state.kind) {
    case 'checking':
      return <Centered>checking sign-in…</Centered>
    case 'unreachable':
      return (
        <Centered>
          <p className="max-w-[420px] text-[var(--color-ink-2)]">
            The server is running but didn't answer the sign-in check ({state.message}).
          </p>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </Centered>
      )
    case 'needs-owner':
      return <OwnerGate mode="create-owner" status={state.status} theme={resolvedTheme} onSession={acceptSession} />
    case 'needs-sign-in':
      return <OwnerGate mode="sign-in" status={state.status} theme={resolvedTheme} onSession={acceptSession} />
    case 'signed-in':
      return <AccountContext.Provider value={state.status.user}>{children}</AccountContext.Provider>
  }
}
