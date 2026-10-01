import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import PlaybackSpike from './PlaybackSpike'
import LibrarySetup, { Centered } from './LibrarySetup'
import { useServerReady } from './hooks/useServerReady'
import { ServerUpdateNotice } from './shell/ServerUpdateNotice'
import { ToastProvider } from './ui/Toast'
import { useWsEvent } from './hooks/useWs'
import Canvas, { type CanvasHandle } from './canvas/Canvas'
import { resolveEdgeColorOverrides } from './canvas/edgeTypes'
import { resolveNodeSizeMultipliers } from './canvas/nodeTypes'
import { usePlayback } from './playback/usePlayback'
import HygieneView from './hygiene/HygieneView'
import { AppShell } from './shell/AppShell'
import { TransportDock } from './shell/TransportDock'
import { CollectionPanel, type CollectionPanelHandle } from './panels/CollectionPanel'
import { MusicMapSettings } from './panels/MusicMapSettings'
import { LegatoSettings } from './panels/LegatoSettings'
import { DatabaseInspector } from './panels/DatabaseInspector'
import { TagManager } from './panels/TagManager'
import { Favourites } from './panels/Favourites'
import { Playlists } from './panels/Playlists'
import { API_BASE } from './config/serverHost'
import { NowPlayingPanel } from './panels/NowPlayingPanel'
import { NodeInspector } from './panels/NodeInspector'
import { useSettings } from './hooks/useSettings'
import { useTheme } from './hooks/useTheme'
import { useMapPresetHistory } from './hooks/useMapPresetHistory'
import type { ReplayGainMode, RepeatMode } from './playback/usePlayback'
import { LeftPanelHeader } from './shell/LeftPanelHeader'
import { RightPanelHeader } from './shell/RightPanelHeader'
import { InspectorRail } from './shell/InspectorRail'
import { InspectorPanel } from './shell/InspectorPanel'
import { RightPanel } from './shell/RightPanel'
import { ViewSwitch, type ViewMode } from './shell/ViewSwitch'
import type { RailDestination } from './shell/rail'
import { LibraryView } from './library/LibraryView'
import { useAuth } from './auth/useAuth'
import { OwnerGate } from './auth/OwnerGate'
import { Button } from './ui/Button'
import { LAUNCHED_OFFLINE } from './pwa/register'

// Phase 1 of THE SPIKE (see projects/Legato.md): does sigma.js/graphology
// hold up at ~5k nodes at all, in a plain browser tab, before Tauri/WebKitGTK
// is anywhere near the picture. If this is janky here, wrapping it in Tauri
// won't fix it — that's a separate, later question.

const NODE_COUNT = 10000
const EDGES_PER_NODE = 2 // ~20k edges: rough stand-in for artist/label/producer edge density

// D12: off -> all -> one -> off. The dock's single repeat button cycles
// through this rather than exposing three separate controls.
const NEXT_REPEAT_MODE: Record<RepeatMode, RepeatMode> = {
  off: 'all',
  all: 'one',
  one: 'off',
}

function buildGraph(): Graph {
  const graph = new Graph()

  for (let i = 0; i < NODE_COUNT; i++) {
    const angle = (i / NODE_COUNT) * Math.PI * 2
    const radius = 400 + Math.random() * 400
    graph.addNode(`n${i}`, {
      label: `Node ${i}`,
      x: Math.cos(angle) * radius + (Math.random() - 0.5) * 100,
      y: Math.sin(angle) * radius + (Math.random() - 0.5) * 100,
      size: 2 + Math.random() * 2,
      color: `hsl(${(i * 37) % 360}, 70%, 55%)`,
    })
  }

  for (let i = 0; i < NODE_COUNT; i++) {
    for (let e = 0; e < EDGES_PER_NODE; e++) {
      const target = Math.floor(Math.random() * NODE_COUNT)
      if (target === i) continue
      const source = `n${i}`
      const targetId = `n${target}`
      if (!graph.hasEdge(source, targetId)) {
        graph.addEdge(source, targetId, { size: 0.5, color: '#333' })
      }
    }
  }

  return graph
}

function CanvasSpike() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [stats, setStats] = useState({ nodes: 0, edges: 0, fps: 0 })

  useEffect(() => {
    if (!containerRef.current) return

    const graph = buildGraph()
    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      defaultEdgeType: 'line',
    })

    setStats((s) => ({ ...s, nodes: graph.order, edges: graph.size }))

    // Raw requestAnimationFrame rate. Not sigma's internal render count —
    // it's a proxy for whether the browser is keeping up with the page at
    // all while sigma is doing its WebGL work. If the GPU/main thread falls
    // behind, this number drops too, which is the thing we actually care
    // about: does interacting with a 5k-node canvas feel smooth.
    let frames = 0
    let last = performance.now()
    let raf: number
    const tick = () => {
      frames++
      const now = performance.now()
      if (now - last >= 1000) {
        setStats((s) => ({ ...s, fps: frames }))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      renderer.kill()
    }
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#111' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          color: '#fff',
          fontFamily: 'monospace',
          fontSize: 14,
          background: 'rgba(0,0,0,0.65)',
          padding: '8px 12px',
          borderRadius: 4,
          lineHeight: 1.5,
        }}
      >
        <div>nodes: {stats.nodes}</div>
        <div>edges: {stats.edges}</div>
        <div>frame rate: {stats.fps}</div>
        <div style={{ marginTop: 6, opacity: 0.7 }}>
          drag to pan, scroll to zoom — judge feel, not just the number
        </div>
      </div>
    </div>
  )
}

const TABS = {
  canvas: { label: 'Canvas spike', component: CanvasSpike },
  playback: { label: 'Playback spike', component: PlaybackSpike },
} as const

// THE SPIKE's two demos, kept alive as manual smoke tests (not deleted) but
// moved behind ?debug=1 — they're dev tooling, not the app a real library
// folder points at. See the MVP roadmap's M0 milestone.
function DebugSpikes() {
  const [tab, setTab] = useState<keyof typeof TABS>('canvas')
  const Active = TABS[tab].component

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div style={{ position: 'fixed', inset: 0 }}>
        <Active />
      </div>
      <div
        style={{
          position: 'fixed',
          bottom: 12,
          left: 12,
          zIndex: 10,
          display: 'flex',
          gap: 6,
        }}
      >
        {(Object.keys(TABS) as (keyof typeof TABS)[]).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: '6px 12px',
              fontFamily: 'monospace',
              fontSize: 12,
              background: tab === key ? '#fff' : 'rgba(255,255,255,0.15)',
              color: tab === key ? '#111' : '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {TABS[key].label}
          </button>
        ))}
      </div>
    </div>
  )
}

// Once a library root is configured, the canvas is the front door — matches
// LibrarySetup's own scope note (M0's job is just proving the folder-picker
// round trip; the canvas taking over from there is M3's).
function MainApp() {
  // #136/D10: per-device, applies (and keeps applying — system-theme and
  // Tauri window-theme changes) as a side effect of the hook itself. See
  // useTheme.ts. resolvedTheme threads down to the two surfaces that still
  // need to know which theme is active for a reason CSS tokens can't cover
  // on their own — swapping an <img> wordmark source — everything else goes
  // through var(--color-*) instead.
  const { preference: themePreference, resolvedTheme, setPreference: setThemePreference } = useTheme()
  const [hasLibrary, setHasLibrary] = useState<boolean | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null)
  const [hygieneOpen, setHygieneOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  // Set only by TagManager's "edit" action (issue #65) — the inspector
  // consumes it once, on the node it was requested for, and clears it, so
  // navigating elsewhere inside an already-open inspector never re-triggers
  // edit mode on a node nobody asked to edit.
  const [autoEditNodeId, setAutoEditNodeId] = useState<number | null>(null)
  // The rail's own selection doubles as the left shell's expand/collapse
  // state — "exactly one active at a time, or none when collapsed" is
  // literally what DESIGN.md's shell section specifies, so there is no
  // separate boolean to keep in sync with it. The right (now-playing) side
  // collapses independently, via its own header icon — the two sides never
  // shared a single collapse state in the mockup to begin with, only a
  // shared *concept* of one. Both default open, matching today's baseline.
  const [activeRailDestination, setActiveRailDestination] = useState<RailDestination | null>('search')
  // Starts false, not true: usePlayback's own status always starts at
  // currentRecordingNodeId: null (nothing resumes synchronously on mount),
  // so the hasQueuedContent effect below would immediately correct a `true`
  // default back to false anyway — starting here avoids a one-frame flash
  // of the idle "nothing playing" panel on every launch.
  const [rightPanelExpanded, setRightPanelExpanded] = useState(false)
  // The left header's collapsed-state expand icon (Figma's later "Panel
  // Collapse" revision, node 66:85 — see DESIGN.md "Panel collapsed (v2)")
  // has no destination of its own to open, unlike a rail icon click. This
  // remembers whichever destination was active before collapsing so the
  // header button restores it, rather than forcing back to 'search' every
  // time.
  const lastRailDestinationRef = useRef<RailDestination>('search')
  const { settings, updateSettings } = useSettings()
  // #127: held here rather than inside MusicMapSettings.tsx itself, which
  // unmounts every time the rail switches to another destination — see
  // useMapPresetHistory's own comment. Its undo also answers the window's
  // Cmd/Ctrl+Z below, so it has to live somewhere that outlives the panel
  // regardless.
  const mapPresets = useMapPresetHistory(settings, updateSettings)
  // Issue #126, D11: the map/library switch persists like every other
  // settings-backed toggle in the app (hoverDimEnabled, replaygainMode,
  // etc.) rather than resetting to the map on every launch.
  const viewMode = (settings.viewMode as ViewMode) || 'map'
  // Lifted out of CollectionPanel's SearchField (which used to own this as
  // local state) so the library view can filter against the exact same
  // text — "shared search" per the issue means one query, not two search
  // boxes that happen to agree by coincidence.
  const [libraryQuery, setLibraryQuery] = useState('')
  const replaygainMode = (settings.replaygainMode as ReplayGainMode) || 'track'
  // D12: repeat is a persisted player setting (unlike shuffle, which lives
  // entirely inside usePlayback's own playSequence/originalOrder), so it
  // reads from the same settings store as replaygainMode rather than being
  // hook-internal state.
  const repeatMode = (settings.repeatMode as RepeatMode) || 'off'
  const playback = usePlayback(replaygainMode, repeatMode)
  const canvasRef = useRef<CanvasHandle>(null)
  const collectionPanelRef = useRef<CollectionPanelHandle>(null)

  // #87: the now-playing panel auto-expands the moment something starts
  // playing and auto-collapses the moment playback goes idle again — but
  // only as a one-shot nudge on that transition, not a standing override.
  // Keyed on the has-content boolean rather than the raw node id so it
  // fires once per transition instead of once per track change. Because
  // this only *sets* rightPanelExpanded rather than masking it at render
  // time (the old `rightPanelExpanded && currentRecordingNodeId != null`
  // approach), an explicit collapse/expand click while the transition
  // hasn't fired again — including expanding the panel by hand while
  // nothing is queued, to reach NowPlayingPanel's "nothing playing"
  // quick-play state — sticks until the next transition.
  const hasQueuedContent = playback.status.currentRecordingNodeId != null
  useEffect(() => {
    setRightPanelExpanded(hasQueuedContent)
  }, [hasQueuedContent])

  // #46 "rebuild map" (LegatoSettings' "canvas" group): the server clears
  // every node's manual placement and reseeds with fresh jitter, but
  // Canvas.tsx's own graph sync deliberately never moves an already-tracked
  // node's x/y (right for every other kind of data refresh — enrichment,
  // scan — wrong for this one). A full remount is the simplest way to
  // actually show it: bumping this key tears down and rebuilds the whole
  // graphology/Sigma/force-simulation stack from scratch, so every node's
  // initial position comes fresh from the now-rebuilt seed/user_x columns.
  const [rebuildEpoch, setRebuildEpoch] = useState(0)
  useWsEvent(['layout:rebuilt'], () => setRebuildEpoch((e) => e + 1))

  // Settings gating Canvas's hover-dim effect and reduced-motion override —
  // string flags, matching the store's existing string-only convention
  // (enrichmentEnabled above uses the same '!== "false"' idiom).
  const dimOnHoverEnabled = settings.hoverDimEnabled !== 'false'
  const reducedMotionForced = settings.reducedMotionForced === 'true'

  // CSS-driven motion (see src/index.css) has no access to a React prop, so
  // the force-on override is mirrored onto the root element as a data
  // attribute the base reduced-motion layer also matches against.
  useEffect(() => {
    if (reducedMotionForced) document.documentElement.dataset.reducedMotion = 'true'
    else delete document.documentElement.dataset.reducedMotion
  }, [reducedMotionForced])

  // Music Map settings' "nodes > size" / "links > thickness" / "links >
  // colours" — read live by Canvas.tsx's reducers, so a change made while
  // looking at the canvas shows up immediately. edgeColorOverrides and
  // nodeSizeMultipliers are both memoized so their identity is stable
  // across renders that don't touch any edgeColor:*/nodeSize:* key — Canvas
  // re-reads them (and calls renderer.refresh()) on every identity change.
  const edgeThicknessMultiplier = Number(settings.edgeThicknessMultiplier ?? '1')
  const showArtistArt = settings.showImagesArtists !== 'false'
  const showReleaseArt = settings.showImagesAlbums !== 'false'
  const showTrackArt = settings.showImagesTracks !== 'false'
  // Music Map settings' "nodes > producers" (#24) — 'credit' nodes
  // (producer/engineer credits) are opt-in, off by default, since they're
  // new to an already-tuned graph. See Canvas.tsx's syncGraph.
  const showCreditNodes = settings.showCreditNodes === 'true'
  const edgeColorOverrides = useMemo(() => resolveEdgeColorOverrides(settings), [settings])
  const nodeSizeMultipliers = useMemo(() => resolveNodeSizeMultipliers(settings), [settings])

  // Music Map settings' "nodes > lock" and "forces" + "links > distance" —
  // real live physics inputs since 2026-08-29 (see Legato.md), read the same
  // live way as the multipliers above.
  const nodesLocked = settings.nodePositionsLocked === 'true'
  const forceCenterStrength = Number(settings.forceCenterStrength ?? '0.03')
  const forceRepelStrength = Number(settings.forceRepelStrength ?? '150')
  const forceLinkStrength = Number(settings.forceLinkStrength ?? '0.15')
  const linkDistance = Number(settings.linkDistance ?? '80')

  // Applies a saved device preference on launch (Rust's own device_name
  // starts at None every fresh process) and again on any change made from
  // the settings screen — see playback.rs's open_stream for the "falls
  // back to default if the device is gone" half of this contract.
  useEffect(() => {
    if (settings.audioDevice) void playback.setAudioDevice(settings.audioDevice)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.audioDevice])

  // Every "go to this node" action in the app — search, similarity
  // thumbnails, fact links, hygiene worklist items — resolves through here,
  // so selecting is always also navigating. Canvas-first spatial navigation
  // is the actual point (Legato.md), not a side effect of clicking a node
  // directly on the graph.
  const selectAndFly = (id: number) => {
    setSelectedNodeId(id)
    canvasRef.current?.flyToNode(id)
  }

  // TagManager's "edit" action (issue #65): select, fly, open the
  // inspector, and mark this node as the one to drop straight into edit
  // mode on — rather than the user hunting for the pencil icon themselves.
  const selectFlyAndEdit = (id: number) => {
    selectAndFly(id)
    setInspectorOpen(true)
    setAutoEditNodeId(id)
  }

  // Escape unwinds one layer at a time. The inspector owns its own Escape
  // handling (useModalTransition), so this only has to cover the layer under
  // it — clearing a selection, and with it the canvas card. Guarded on the
  // modal being shut so one press never does both.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || inspectorOpen || hygieneOpen) return
      setSelectedNodeId(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [inspectorOpen, hygieneOpen])

  // Core shortcuts (documented in the Settings "shortcuts" section, so none
  // of this is hidden): Space toggles playback, "/" focuses search.
  // Suppressed while any modal is open — they'd either do nothing useful
  // behind it or double up with the modal's own controls — and while focus
  // is on an element that already has its own meaning for these keys
  // (typing, or a focused control's native Space-to-activate).
  useEffect(() => {
    function isTypingTarget(el: Element | null): boolean {
      if (!el) return false
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName)) return true
      return (el as HTMLElement).isContentEditable
    }

    function handleShortcut(e: KeyboardEvent) {
      if (inspectorOpen || hygieneOpen) return

      // #127: the map's session undo. Checked before the Space/"/" guard
      // below rather than sharing it — isTypingTarget also treats a focused
      // <button> as "typing" (so Space doesn't fire its native click), which
      // would otherwise swallow the exact "click a preset, immediately
      // Cmd+Z it" gesture this shortcut exists for. Undo only yields to
      // actual text editing.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        const activeEl = document.activeElement as HTMLElement | null
        const editingText = activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA' || activeEl?.isContentEditable === true
        if (!editingText) {
          e.preventDefault()
          mapPresets.undo()
        }
        return
      }

      if (isTypingTarget(document.activeElement)) return

      if (e.code === 'Space') {
        e.preventDefault()
        if (playback.currentTitle == null) return
        if (playback.status.playing) playback.pause()
        else playback.resume()
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        collectionPanelRef.current?.focusSearch()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [inspectorOpen, hygieneOpen, playback, mapPresets])

  useEffect(() => {
    fetch(`${API_BASE}/library-roots`)
      .then((r) => r.json())
      .then((roots: unknown[]) => setHasLibrary(roots.length > 0))
  }, [])

  if (hasLibrary === null) return <Centered>loading library…</Centered>
  if (!hasLibrary) return <LibrarySetup onLibraryReady={() => setHasLibrary(true)} theme={resolvedTheme} />

  // #87: no more render-time override here — rightPanelExpanded (nudged by
  // the hasQueuedContent effect above, otherwise set only by the user's own
  // collapse/expand clicks) is the whole answer now. It used to be
  // `rightPanelExpanded && currentRecordingNodeId != null`, which forced the
  // panel collapsed any time playback was idle regardless of what the user
  // had just clicked — the mechanism NowPlayingCollapsed's quick-play
  // suggestion leaned on to stay reachable, at the cost of that same
  // suggestion floating over the canvas unasked for any time playback was
  // idle. NowPlayingPanel now renders its own "nothing playing" + quick-play
  // state when explicitly expanded with nothing queued, so there's nothing
  // left for a render-time override to protect against.
  const rightPanelDisplayExpanded = rightPanelExpanded

  return (
    <AppShell>
      {viewMode === 'map' ? (
        <Canvas
          key={rebuildEpoch}
          ref={canvasRef}
          selectedNodeId={selectedNodeId}
          onSelectNode={(id) => {
            setSelectedNodeId(id)
            // Deselecting has to take the inspector with it — it is a view of
            // the selected node, and there would be nothing behind it.
            if (id == null) setInspectorOpen(false)
          }}
          onOpenInspector={() => setInspectorOpen(true)}
          playback={playback}
          dimOnHoverEnabled={dimOnHoverEnabled}
          reducedMotionForced={reducedMotionForced}
          showArtistArt={showArtistArt}
          showReleaseArt={showReleaseArt}
          showTrackArt={showTrackArt}
          showCreditNodes={showCreditNodes}
          nodeSizeMultipliers={nodeSizeMultipliers}
          edgeThicknessMultiplier={edgeThicknessMultiplier}
          edgeColorOverrides={edgeColorOverrides}
          nodesLocked={nodesLocked}
          forceCenterStrength={forceCenterStrength}
          forceRepelStrength={forceRepelStrength}
          forceLinkStrength={forceLinkStrength}
          linkDistance={linkDistance}
          onRestoreDefaults={mapPresets.restoreDefaults}
          theme={resolvedTheme}
        />
      ) : (
        // Selecting a row here reuses the exact same selectAndFly the
        // canvas's own node click uses — flyToNode on canvasRef is a no-op
        // while Canvas is unmounted (the ref is null), so the selection
        // itself carries over but the camera move is deferred rather than
        // queued: switching back to the map does not re-fly to whatever was
        // last picked here. Documented scope boundary, not a bug — see
        // DESIGN.md "Library view".
        <LibraryView query={libraryQuery} onSelectNode={selectAndFly} />
      )}

      <ViewSwitch value={viewMode} onChange={(mode) => void updateSettings({ viewMode: mode })} />

      <LeftPanelHeader
        expanded={activeRailDestination != null}
        onCollapse={() => setActiveRailDestination(null)}
        onExpand={() => setActiveRailDestination(lastRailDestinationRef.current)}
        theme={resolvedTheme}
      />
      <InspectorRail
        active={activeRailDestination}
        onSelect={(id) => {
          lastRailDestinationRef.current = id
          setActiveRailDestination(id)
        }}
      />
      {activeRailDestination && (
        <InspectorPanel
          active={activeRailDestination}
          graphContent={<MusicMapSettings settings={settings} updateSettings={updateSettings} mapPresets={mapPresets} />}
          settingsContent={
            <LegatoSettings
              settings={settings}
              updateSettings={updateSettings}
              onSetAudioDevice={playback.setAudioDevice}
              themePreference={themePreference}
              onSetThemePreference={setThemePreference}
            />
          }
          tagsContent={<TagManager onSelectNode={selectAndFly} onEditNode={selectFlyAndEdit} />}
          databaseContent={<DatabaseInspector />}
          favouritesContent={<Favourites onSelectNode={selectAndFly} playback={playback} />}
          playlistsContent={<Playlists playback={playback} />}
        >
          <CollectionPanel
            ref={collectionPanelRef}
            onSelectNode={selectAndFly}
            onOpenMaintenance={() => setHygieneOpen(true)}
            playback={playback}
            query={libraryQuery}
            onQueryChange={setLibraryQuery}
          />
        </InspectorPanel>
      )}

      <RightPanelHeader
        expanded={rightPanelDisplayExpanded}
        onCollapse={() => setRightPanelExpanded(false)}
        onExpand={() => setRightPanelExpanded(true)}
      />
      {/* Now playing, and only now playing. Selection used to take this
       * panel over (P-5's "one node-detail surface"), which meant looking at
       * anything cost you sight of what was playing; the selected node now
       * has its own surface on the canvas, and the deeper half of P-5's
       * argument survives as shared logic (panels/MetadataFields.tsx,
       * ConnectionsContent.tsx, useLyrics.ts, useMetadataEditing.ts) behind
       * two different layouts — this panel's stacked disclosures
       * (NowPlayingSections.tsx) and the inspector's unchanged pager
       * (NodeDetailPages.tsx). */}
      <RightPanel
        expanded={rightPanelDisplayExpanded}
        collapsedNodeId={playback.status.currentRecordingNodeId ?? null}
        onExpand={() => setRightPanelExpanded(true)}
      >
        <NowPlayingPanel
          nodeId={playback.status.currentRecordingNodeId ?? null}
          isPlaying={playback.status.currentRecordingNodeId != null}
          upNext={playback.upNext}
          queueBusy={playback.queueBusy}
          onSelectNode={selectAndFly}
          onPlay={playback.playNode}
          queuePlayback={playback}
          onQuickPlay={() => void playback.playRandom()}
        />
      </RightPanel>

      {/* #50: structural chrome only while there's something to transport —
       * hidden outright rather than shown inert with every control disabled. */}
      {playback.currentTitle != null && (
        <TransportDock
          status={playback.status}
          shuffled={playback.shuffled}
          queueBusy={playback.queueBusy}
          repeatMode={repeatMode}
          problem={playback.problem}
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
      )}

      {inspectorOpen && selectedNodeId != null && (
        <NodeInspector
          nodeId={selectedNodeId}
          isPlaying={selectedNodeId === playback.status.currentRecordingNodeId}
          queueBusy={playback.queueBusy}
          autoEditNodeId={autoEditNodeId}
          onAutoEditConsumed={() => setAutoEditNodeId(null)}
          onSelectNode={(id) => {
            // Following a fact or edge link inside the inspector moves the
            // selection — and the canvas underneath — rather than opening a
            // second inspector on top of the first.
            selectAndFly(id)
          }}
          onPlay={playback.playNode}
          onClose={() => {
            setInspectorOpen(false)
            setAutoEditNodeId(null)
          }}
        />
      )}

      {hygieneOpen && (
        <HygieneView
          onSelectNode={(id) => {
            selectAndFly(id)
            setHygieneOpen(false)
          }}
          onClose={() => setHygieneOpen(false)}
        />
      )}
    </AppShell>
  )
}

export default function App() {
  const { ready, everConnected, server } = useServerReady()
  const debug = new URLSearchParams(window.location.search).has('debug')

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

  const app = debug ? <DebugSpikes /> : <MainApp />
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
          <p className="max-w-[420px] text-[var(--color-muted)]">
            The server is running but didn't answer the sign-in check ({state.message}).
          </p>
          <Button onClick={() => void refresh()}>try again</Button>
        </Centered>
      )
    case 'needs-owner':
      return <OwnerGate mode="create-owner" status={state.status} theme={resolvedTheme} onSession={acceptSession} />
    case 'needs-sign-in':
      return <OwnerGate mode="sign-in" status={state.status} theme={resolvedTheme} onSession={acceptSession} />
    case 'signed-in':
      return children
  }
}
