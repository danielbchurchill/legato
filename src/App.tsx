import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Centered } from './shell/Centered'
import { useServerReady, type ServerStatus } from './hooks/useServerReady'
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
import { API_BASE, DEFAULT_SERVER_ORIGIN, SERVER_ORIGIN } from './config/serverHost'
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
import { ErrorBoundary, RenderError } from './ui/ErrorBoundary'
import { useCoverColor, withAlpha } from './ui/coverColor'
import { LAUNCHED_OFFLINE } from './pwa/register'
import { ConnectScreen } from './connect/ConnectScreen'
import { useLegatoRenewal } from './connect/hooks'
import { OPEN_CONNECT_EVENT, openConnectScreen, type ConnectReason } from './connect/openConnect'
import { ServerUnreachableOverShell, ServerUnreachableWindow, type UnreachableView } from './connect/ServerUnreachable'
import { describeOutage, inferReason, outageFooter, pathFor } from './connect/unreachable'
import { useReconnectEpoch } from './connect/reconnect'
import { UnreachableContext, useUnreachableInShell, type UnreachableSurface } from './connect/unreachableSurface'
import { IS_TAURI } from './config/runtime'
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

// How long "loading library…" waits to ask for the library's folders again
// when the answer didn't come, or wasn't a list.
const LIBRARY_ROOTS_RETRY_MS = 3000

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

// A right-hand panel that fails to draw says so and leaves the rest of the
// window running. Its boundary is keyed by the node it shows, so picking
// another one clears the error by itself.
const panelError = (error: Error, reset: () => void) => (
  <RenderError title="This panel couldn't be drawn." error={error} action={<Button onClick={reset}>try again</Button>} />
)

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
  const known = useRef(false)
  // #119: again after an outage, so a load it broke doesn't leave "loading
  // library…" up for good, and folders added elsewhere meanwhile show.
  const reconnects = useReconnectEpoch()

  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      void fetch(`${API_BASE}/library-roots`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((roots: unknown) => {
          if (cancelled) return
          // Only a list says whether there's a library. A 401 or a 500
          // answers with an error object, and taking that for "no folders"
          // would put "Add your music" over a real library.
          if (Array.isArray(roots)) {
            known.current = true
            setHasLibrary(roots.length > 0)
          } else if (!known.current) {
            // Nothing to show until it's known: ask again, rather than leave
            // "loading library…" up for good.
            retry = setTimeout(load, LIBRARY_ROOTS_RETRY_MS)
          }
        })
    }
    load()
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [reconnects])

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
  const unreachable = useUnreachableInShell()
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null)
  const [leftView, setLeftView] = useState<LeftView | null>(null)
  const [rightView, setRightView] = useState<RightView | null>(null)
  const [nowPlayingTab, setNowPlayingTab] = useState<NowPlayingTab>('next')
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('overview')
  const [searchOpen, setSearchOpen] = useState(false)
  const { settings, loaded: settingsLoaded, updateSettings } = useSettings()
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
      }),
    [windowSize.width, windowSize.height, leftView, rightView],
  )

  // #46 "rebuild map": the server reseeds every node; a full Canvas remount
  // is the simplest way to show it, since the live graph sync deliberately
  // never moves a node it already tracks. The remount waits for a refetch
  // (#274): the graph data lives above the map, and a map remounted on the
  // old data would reopen on the saved layout the rebuild just cleared.
  const [rebuildEpoch, setRebuildEpoch] = useState(0)
  const refetchGraph = graph.refetch
  useWsEvent(['layout:rebuilt'], () => {
    const remount = () => setRebuildEpoch((e) => e + 1)
    void refetchGraph().then(remount, remount)
  })

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
    const tracks = graph.nodes.filter((n) => n.type === 'recording')
    if (tracks.length === 0) return
    void playback.playLibrary(
      shuffled(tracks)
        .slice(0, SHUFFLE_LIBRARY_SIZE)
        .map((n) => ({ id: n.id, title: n.title })),
    )
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

  const addMusic = (
    <AddMusic
      onAdded={() => {
        onLibraryAdded()
        // The first scan is drawn on the map as it runs.
        void updateSettings({ viewMode: 'map' })
      }}
    />
  )

  return (
    <ShellLayoutContext.Provider value={layout}>
      <AppShell>
        {/* The stage waits for settings: they say which view it is, and the
         * map (#274) opens on its saved layout without settling, so force
         * settings or "show producers" arriving a moment later would set
         * it moving again. */}
        {!settingsLoaded ? null : !hasLibrary ? (
          // The library keeps its header over first run, as its frame
          // draws it; the map has no header to keep.
          viewMode === 'library' ? (
            <LibraryView
              selectedNodeId={selectedNodeId}
              onOpenNode={openDetails}
              playback={playback}
              settings={settings}
              updateSettings={updateSettings}
              firstRun={addMusic}
            />
          ) : (
            <div className="absolute inset-y-0" style={{ left: layout.leftOccupancy, right: layout.rightOccupancy }}>
              {addMusic}
            </div>
          )
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
            <ErrorBoundary key={playingNodeId} fallback={panelError}>
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
            </ErrorBoundary>
          </RightPanel>
        )}
        {rightView === 'details' && selectedNodeId != null && (
          <RightPanel label="Details" wash={rightWash}>
            <ErrorBoundary key={selectedNodeId} fallback={panelError}>
              <NodeDetails
                nodeId={selectedNodeId}
                tab={detailsTab}
                onTabChange={setDetailsTab}
                playback={playback}
                onFocusNode={focusNode}
              />
            </ErrorBoundary>
          </RightPanel>
        )}

        {/* #119: over the stage and panels, under the player, so whatever's
         * buffered keeps playing and can still be paused. */}
        {unreachable && <ServerUnreachableOverShell view={unreachable} />}

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
          // screen's attention. Hidden while the server's unreachable too,
          // since nothing could start.
          !unreachable &&
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

// Issue #117: how long "starting legato-server…" waits before it offers
// another server. The desktop app's own server is usually up in a second or
// two, and a link there from the first frame would be noise.
const OFFER_ANOTHER_SERVER_MS = 5000
// Issue #119: how long the desktop app's own server gets to start before
// the window says it hasn't. A migration's backup of a big library can take
// a while, and until then "starting" is the truth.
const EMBEDDED_START_GRACE_MS = 15_000

const SERVER_PATH = pathFor(SERVER_ORIGIN, IS_TAURI && SERVER_ORIGIN === DEFAULT_SERVER_ORIGIN)

const connectElsewhere = () => openConnectScreen('unreachable')

// What the unreachable state says, worked out from what useServerReady saw.
// Built again only when that changes, not on every failed check: the shell
// reads it through context, and a new object a second would re-render the
// whole workspace under the state.
function useUnreachableView({ outage, name, everConnected, retrying, retry }: ServerStatus): UnreachableView | null {
  return useMemo(() => {
    if (!outage) return null
    const now = outage.since
    const reason = inferReason({ ...outage, path: SERVER_PATH }, now)
    const copy = describeOutage(reason, {
      path: SERVER_PATH,
      name,
      host: new URL(SERVER_ORIGIN).host,
      lastSeenAt: outage.lastSeenAt,
      everConnected,
      now,
    })
    return {
      ...copy,
      footer: outageFooter({ everConnected, triedAt: outage.triedAt }),
      retrying,
      onRetry: retry,
      onConnectElsewhere: connectElsewhere,
    }
  }, [outage, name, everConnected, retrying, retry])
}

function useUnreachableSurface(view: UnreachableView | null): { surface: UnreachableSurface; claimed: boolean } {
  const [claims, setClaims] = useState(0)
  const claim = useCallback(() => {
    setClaims((n) => n + 1)
    return () => setClaims((n) => n - 1)
  }, [])
  const surface = useMemo(() => ({ view, claim }), [view, claim])
  return { surface, claimed: claims > 0 }
}

function useConnectScreen(): { reason: ConnectReason | null; close: () => void } {
  const [reason, setReason] = useState<ConnectReason | null>(null)
  useEffect(() => {
    const open = (event: Event) => setReason((event as CustomEvent<ConnectReason>).detail ?? 'switch')
    window.addEventListener(OPEN_CONNECT_EVENT, open)
    return () => window.removeEventListener(OPEN_CONNECT_EVENT, open)
  }, [])
  return { reason, close: () => setReason(null) }
}

function useAfter(ms: number, active: boolean): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => setElapsed(true), ms)
    return () => clearTimeout(timer)
  }, [ms, active])
  return elapsed
}

export default function App() {
  const connection = useServerReady()
  const { ready, everConnected, server } = connection
  const connect = useConnectScreen()
  const { resolvedTheme } = useTheme()
  const chosen = SERVER_ORIGIN !== DEFAULT_SERVER_ORIGIN
  const offerAnother = useAfter(OFFER_ANOTHER_SERVER_MS, !ready) || chosen || everConnected || LAUNCHED_OFFLINE
  const embeddedHadTime = useAfter(EMBEDDED_START_GRACE_MS, !everConnected)
  const unreachable = useUnreachableView(connection)
  const { surface, claimed } = useUnreachableSurface(unreachable)
  // One element for the life of the window, so a render of App (a try
  // again, the connect screen opening) doesn't render the whole workspace
  // again: React leaves an element it has already rendered alone.
  const app = useMemo(() => <MainApp />, [])

  // Back goes to whatever was there before: the app, a sign-in screen, or
  // the wait for a server that isn't answering. It's drawn over that rather
  // than in its place (#119), so going back finds the app as it was left:
  // the same queue, and anything still playing.
  const connectScreen = connect.reason && (
    <div role="dialog" aria-modal="true" aria-label="Connect to a server" className="relative z-50">
      <ConnectScreen theme={resolvedTheme} reason={connect.reason} onClose={connect.close} />
    </div>
  )

  if (!everConnected) {
    // #119: a server that isn't answering gets the unreachable state, with
    // the desktop app's own server given time to start first.
    if (unreachable && (SERVER_PATH !== 'embedded' || embeddedHadTime)) {
      return (
        <>
          <ServerUnreachableWindow view={unreachable} theme={resolvedTheme} />
          {connectScreen}
        </>
      )
    }
    // #128: an installed web app launched with the server out of reach
    // runs the service worker's cached shell, and "starting" would be a
    // lie there: no browser starts a server. It still polls, so the app
    // comes up by itself once the server answers. #117: the link is the
    // way out when the server this client points at isn't there.
    return (
      <>
        <Centered>
          {SERVER_PATH === 'embedded' ? 'starting legato-server…' : 'connecting…'}
          {offerAnother && <Button onClick={() => openConnectScreen('unreachable')}>connect to a different server</Button>}
        </Centered>
        {connectScreen}
      </>
    )
  }

  // Once the app has run, it stays mounted through an outage (#119): the
  // queue and the web player live in it, and anything buffered keeps
  // playing. The shell draws the unreachable state over itself; anything
  // else (the sign-in check, loading the library) gets the whole window.
  return (
    <UnreachableContext.Provider value={surface}>
      <ToastProvider>
        {/* A server older than migration 0029 has no owner gate and no
         * /auth/status to ask, so it runs ungated exactly as before,
         * with the notice saying to update it. */}
        {server?.outOfDate ? app : <OwnerGated>{app}</OwnerGated>}
        <ServerUpdateNotice server={server} />
      </ToastProvider>
      {unreachable && !claimed && <ServerUnreachableWindow view={unreachable} theme={resolvedTheme} />}
      {connectScreen}
    </UnreachableContext.Provider>
  )
}

// Issue #112: nothing past this point renders until the server has an
// owner and this client holds a session for them.
function OwnerGated({ children }: { children: ReactNode }) {
  const { state, refresh, acceptSession } = useAuth()
  // The same store MainApp's useTheme() reads, not a second copy of the
  // preference, so the two can't disagree (#282).
  const { resolvedTheme } = useTheme()
  useLegatoRenewal(state.kind === 'signed-in')

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
    case 'needs-sign-in':
      return (
        <>
          <OwnerGate
            mode={state.kind === 'needs-owner' ? 'create-owner' : 'sign-in'}
            status={state.status}
            theme={resolvedTheme}
            onSession={acceptSession}
          />
          {/* #117: this may not be the server someone meant to open. */}
          <div className="fixed inset-x-0 bottom-[24px] flex justify-center">
            <Button onClick={() => openConnectScreen('signed-out')}>connect to a different server</Button>
          </div>
        </>
      )
    case 'signed-in':
      return <AccountContext.Provider value={state.status.user}>{children}</AccountContext.Provider>
  }
}
