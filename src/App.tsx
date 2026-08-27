import { useEffect, useRef, useState } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import PlaybackSpike from './PlaybackSpike'
import LibrarySetup, { Centered } from './LibrarySetup'
import { useServerReady } from './hooks/useServerReady'
import Canvas, { type CanvasHandle } from './canvas/Canvas'
import { defaultPanelWidthPx } from './canvas/panelSizing'
import { usePlayback } from './playback/usePlayback'
import HygieneView from './hygiene/HygieneView'
import { AppShell } from './shell/AppShell'
import { Panel } from './shell/Panel'
import { GraphToggle } from './shell/GraphToggle'
import { GRANULARITIES, type Granularity } from './shell/granularity'
import { TransportDock } from './shell/TransportDock'
import { CollectionPanel, type CollectionPanelHandle } from './panels/CollectionPanel'
import { SERVER_HOST } from './config/serverHost'
import { NowPlayingPanel } from './panels/NowPlayingPanel'
import { NodeInspector } from './panels/NodeInspector'
import { SettingsView } from './settings/SettingsView'
import { useSettings } from './hooks/useSettings'
import type { ReplayGainMode } from './playback/usePlayback'

// Phase 1 of THE SPIKE (see projects/Legato.md): does sigma.js/graphology
// hold up at ~5k nodes at all, in a plain browser tab, before Tauri/WebKitGTK
// is anywhere near the picture. If this is janky here, wrapping it in Tauri
// won't fix it — that's a separate, later question.

const NODE_COUNT = 10000
const EDGES_PER_NODE = 2 // ~20k edges: rough stand-in for artist/label/producer edge density

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
  const [hasLibrary, setHasLibrary] = useState<boolean | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null)
  const [hygieneOpen, setHygieneOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [granularity, setGranularity] = useState<Granularity>('albums')
  const { settings, loaded: settingsLoaded, updateSettings } = useSettings()
  const replaygainMode = (settings.replaygainMode as ReplayGainMode) || 'track'
  const playback = usePlayback(replaygainMode)
  const canvasRef = useRef<CanvasHandle>(null)
  const collectionPanelRef = useRef<CollectionPanelHandle>(null)

  // Settings gating Canvas's hover-dim effect and reduced-motion override —
  // string flags, matching the store's existing string-only convention
  // (enrichmentEnabled above uses the same '!== "false"' idiom).
  const dimOnHoverEnabled = settings.hoverDimEnabled !== 'false'
  const reducedMotionForced = settings.reducedMotionForced === 'true'

  // Applied once, when settings first arrive, not on every settings change —
  // switching granularity mid-session is the user's live choice and
  // shouldn't be fought by a stale default the moment something else in
  // Settings is saved.
  const appliedDefaultGranularity = useRef(false)
  useEffect(() => {
    if (!settingsLoaded || appliedDefaultGranularity.current) return
    appliedDefaultGranularity.current = true
    const preferred = settings.defaultGranularity
    if ((GRANULARITIES as readonly string[]).includes(preferred)) setGranularity(preferred as Granularity)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded])

  // CSS-driven motion (see src/index.css) has no access to a React prop, so
  // the force-on override is mirrored onto the root element as a data
  // attribute the base reduced-motion layer also matches against.
  useEffect(() => {
    if (reducedMotionForced) document.documentElement.dataset.reducedMotion = 'true'
    else delete document.documentElement.dataset.reducedMotion
  }, [reducedMotionForced])

  // Mirrors the P-8 CSS formula's own vw-based scaling (tokens.css
  // --panel-width used to be this, before panels became independently
  // resizable) — window.innerWidth is a live equivalent of 100vw for a
  // full-bleed frameless window with no horizontal chrome, the same
  // assumption Canvas.tsx's own dims.width already makes.
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // A fixed cap, not a measured one (DESIGN.md has no opinion on a resized
  // panel) — raised automatically past the P-8 default so a very wide window
  // can never make "as wide as it already renders" register as "past the
  // max you're allowed to drag to."
  const PANEL_MAX_WIDTH_PX = 560
  const panelDefaultWidthPx = defaultPanelWidthPx(windowWidth)
  const panelMaxWidthPx = Math.max(PANEL_MAX_WIDTH_PX, panelDefaultWidthPx)

  // null = no drag override yet, i.e. "use the P-8 default." Loaded once
  // from settings (same one-time-on-load shape as defaultGranularity above)
  // rather than re-derived every render, so a live drag isn't fought by its
  // own not-yet-updated settings value.
  const [leftPanelWidthOverride, setLeftPanelWidthOverride] = useState<number | null>(null)
  const [rightPanelWidthOverride, setRightPanelWidthOverride] = useState<number | null>(null)
  const appliedPanelWidths = useRef(false)
  useEffect(() => {
    if (!settingsLoaded || appliedPanelWidths.current) return
    appliedPanelWidths.current = true
    if (settings.panelWidthLeft) setLeftPanelWidthOverride(Number(settings.panelWidthLeft))
    if (settings.panelWidthRight) setRightPanelWidthOverride(Number(settings.panelWidthRight))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded])

  // Re-clamped against the *current* window's floor/cap on every render
  // (not just at drag time) — a persisted override from a much wider
  // session shouldn't render narrower than today's minimum, or wider than
  // today's maximum, just because the window is a different size now.
  const clampPanelWidth = (override: number | null): number =>
    override == null ? panelDefaultWidthPx : Math.min(panelMaxWidthPx, Math.max(panelDefaultWidthPx, override))
  const leftPanelWidthPx = clampPanelWidth(leftPanelWidthOverride)
  const rightPanelWidthPx = clampPanelWidth(rightPanelWidthOverride)

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

  // Escape unwinds one layer at a time. The inspector owns its own Escape
  // handling (useModalTransition), so this only has to cover the layer under
  // it — clearing a selection, and with it the canvas card. Guarded on the
  // modal being shut so one press never does both.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || inspectorOpen || hygieneOpen || settingsOpen) return
      setSelectedNodeId(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [inspectorOpen, hygieneOpen, settingsOpen])

  // Core shortcuts (documented in the Settings "shortcuts" section, so none
  // of this is hidden): Space toggles playback, "/" focuses search, 1/2/3
  // switch granularity. Suppressed while any modal is open — they'd either
  // do nothing useful behind it or double up with the modal's own controls
  // — and while focus is on an element that already has its own meaning for
  // these keys (typing, or a focused control's native Space-to-activate).
  useEffect(() => {
    function isTypingTarget(el: Element | null): boolean {
      if (!el) return false
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName)) return true
      return (el as HTMLElement).isContentEditable
    }

    function handleShortcut(e: KeyboardEvent) {
      if (inspectorOpen || hygieneOpen || settingsOpen) return
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
        return
      }
      const granularityIndex = ['1', '2', '3'].indexOf(e.key)
      if (granularityIndex !== -1) {
        setGranularity(GRANULARITIES[granularityIndex])
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [inspectorOpen, hygieneOpen, settingsOpen, playback])

  useEffect(() => {
    fetch(`http://${SERVER_HOST}:8899/api/v1/library-roots`)
      .then((r) => r.json())
      .then((roots: unknown[]) => setHasLibrary(roots.length > 0))
  }, [])

  if (hasLibrary === null) return <Centered>loading library…</Centered>
  if (!hasLibrary) return <LibrarySetup onLibraryReady={() => setHasLibrary(true)} />

  // The similarity strips' and maintenance preview's anchor: whatever is
  // selected takes precedence (the more recent intent), falling back to
  // whatever is playing when nothing is selected.
  const anchorNodeId = selectedNodeId ?? playback.status.currentRecordingNodeId ?? null

  return (
    <AppShell>
      <Canvas
        ref={canvasRef}
        granularity={granularity}
        selectedNodeId={selectedNodeId}
        onSelectNode={(id) => {
          setSelectedNodeId(id)
          // Deselecting has to take the inspector with it — it is a view of
          // the selected node, and there would be nothing behind it.
          if (id == null) setInspectorOpen(false)
        }}
        onOpenInspector={() => setInspectorOpen(true)}
        dimOnHoverEnabled={dimOnHoverEnabled}
        reducedMotionForced={reducedMotionForced}
        leftPanelWidthPx={leftPanelWidthPx}
        rightPanelWidthPx={rightPanelWidthPx}
      />

      <GraphToggle value={granularity} onChange={setGranularity} />

      <Panel
        side="left"
        title="collection"
        widthPx={leftPanelWidthPx}
        minWidthPx={panelDefaultWidthPx}
        maxWidthPx={panelMaxWidthPx}
        onWidthChange={setLeftPanelWidthOverride}
        onWidthCommit={(px) => {
          setLeftPanelWidthOverride(px)
          void updateSettings({ panelWidthLeft: String(px) })
        }}
      >
        <CollectionPanel
          ref={collectionPanelRef}
          anchorNodeId={anchorNodeId}
          onSelectNode={selectAndFly}
          onOpenMaintenance={() => setHygieneOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </Panel>

      {/* Now playing, and only now playing. Selection used to take this
       * panel over (P-5's "one node-detail surface"), which meant looking at
       * anything cost you sight of what was playing; the selected node now
       * has its own surface on the canvas, and the deeper half of P-5's
       * argument survives inside NodeDetailPages — one component renders a
       * node's detail for both this panel and the inspector. */}
      <Panel
        side="right"
        title="now playing"
        widthPx={rightPanelWidthPx}
        minWidthPx={panelDefaultWidthPx}
        maxWidthPx={panelMaxWidthPx}
        onWidthChange={setRightPanelWidthOverride}
        onWidthCommit={(px) => {
          setRightPanelWidthOverride(px)
          void updateSettings({ panelWidthRight: String(px) })
        }}
      >
        <NowPlayingPanel
          nodeId={playback.status.currentRecordingNodeId ?? null}
          isPlaying={playback.status.currentRecordingNodeId != null}
          upNext={playback.upNext}
          onSelectNode={selectAndFly}
          onPlay={playback.playNode}
        />
      </Panel>

      <TransportDock
        status={playback.status}
        hasTrack={playback.currentTitle != null}
        onPause={playback.pause}
        onResume={playback.resume}
        onSeek={playback.seek}
        onSetVolume={playback.setVolume}
      />

      {inspectorOpen && selectedNodeId != null && (
        <NodeInspector
          nodeId={selectedNodeId}
          isPlaying={selectedNodeId === playback.status.currentRecordingNodeId}
          onSelectNode={(id) => {
            // Following a fact or edge link inside the inspector moves the
            // selection — and the canvas underneath — rather than opening a
            // second inspector on top of the first.
            selectAndFly(id)
          }}
          onPlay={playback.playNode}
          onClose={() => setInspectorOpen(false)}
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

      {settingsOpen && (
        <SettingsView
          settings={settings}
          updateSettings={updateSettings}
          onSetAudioDevice={playback.setAudioDevice}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </AppShell>
  )
}

export default function App() {
  const { ready, everConnected } = useServerReady()
  const debug = new URLSearchParams(window.location.search).has('debug')

  if (!ready) {
    return <Centered>{everConnected ? 'lost connection to legato-server…' : 'starting legato-server…'}</Centered>
  }

  return debug ? <DebugSpikes /> : <MainApp />
}
