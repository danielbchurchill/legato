import { useEffect, useMemo, useRef, useState } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import PlaybackSpike from './PlaybackSpike'
import LibrarySetup, { Centered } from './LibrarySetup'
import { useServerReady } from './hooks/useServerReady'
import Canvas, { type CanvasHandle } from './canvas/Canvas'
import { resolveEdgeColorOverrides } from './canvas/edgeTypes'
import { usePlayback } from './playback/usePlayback'
import HygieneView from './hygiene/HygieneView'
import { AppShell } from './shell/AppShell'
import { GraphToggle } from './shell/GraphToggle'
import { GRANULARITIES, SHOW_IMAGES_SETTING_KEY, type Granularity } from './shell/granularity'
import { TransportDock } from './shell/TransportDock'
import { CollectionPanel } from './panels/CollectionPanel'
import { MusicMapSettings } from './panels/MusicMapSettings'
import { SERVER_HOST } from './config/serverHost'
import { NowPlayingPanel } from './panels/NowPlayingPanel'
import { NodeInspector } from './panels/NodeInspector'
import { SettingsView } from './settings/SettingsView'
import { useSettings } from './hooks/useSettings'
import type { ReplayGainMode } from './playback/usePlayback'
import { LeftPanelHeader } from './shell/LeftPanelHeader'
import { RightPanelHeader } from './shell/RightPanelHeader'
import { InspectorRail } from './shell/InspectorRail'
import { InspectorPanel } from './shell/InspectorPanel'
import { RightPanel } from './shell/RightPanel'
import type { RailDestination } from './shell/rail'

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
  // The rail's own selection doubles as the left shell's expand/collapse
  // state — "exactly one active at a time, or none when collapsed" is
  // literally what DESIGN.md's shell section specifies, so there is no
  // separate boolean to keep in sync with it. The right (now-playing) side
  // collapses independently, via its own header icon — the two sides never
  // shared a single collapse state in the mockup to begin with, only a
  // shared *concept* of one. Both default open, matching today's baseline.
  const [activeRailDestination, setActiveRailDestination] = useState<RailDestination | null>('search')
  const [rightPanelExpanded, setRightPanelExpanded] = useState(true)
  const { settings, loaded: settingsLoaded, updateSettings } = useSettings()
  const replaygainMode = (settings.replaygainMode as ReplayGainMode) || 'track'
  const playback = usePlayback(replaygainMode)
  const canvasRef = useRef<CanvasHandle>(null)

  // Music Map settings' "music map > default view" (src/panels/MusicMapSettings.tsx)
  // — applied once, on the first settings load, so it seeds the initial
  // granularity without fighting a manual switch made afterward via
  // GraphToggle. Settings load asynchronously (useSettings starts at {}
  // before its fetch resolves), so this can't just be granularity's own
  // useState initializer.
  const appliedDefaultGranularityRef = useRef(false)
  useEffect(() => {
    if (!settingsLoaded || appliedDefaultGranularityRef.current) return
    appliedDefaultGranularityRef.current = true
    const preferred = settings.defaultGranularity
    if (preferred && (GRANULARITIES as readonly string[]).includes(preferred)) {
      setGranularity(preferred as Granularity)
    }
  }, [settingsLoaded, settings.defaultGranularity])

  // Music Map settings' "nodes > size" / "links > thickness" / "links >
  // colours" — read live by Canvas.tsx's reducers, so a change made while
  // looking at the canvas shows up immediately. edgeColorOverrides is
  // memoized so its identity is stable across renders that don't touch any
  // edgeColor:* key — Canvas re-reads it (and calls renderer.refresh()) on
  // every identity change.
  const nodeSizeMultiplier = Number(settings.nodeSizeMultiplier ?? '1')
  const edgeThicknessMultiplier = Number(settings.edgeThicknessMultiplier ?? '1')
  const showCoverArt = settings[SHOW_IMAGES_SETTING_KEY[granularity]] !== 'false'
  const edgeColorOverrides = useMemo(() => resolveEdgeColorOverrides(settings), [settings])

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
        showCoverArt={showCoverArt}
        nodeSizeMultiplier={nodeSizeMultiplier}
        edgeThicknessMultiplier={edgeThicknessMultiplier}
        edgeColorOverrides={edgeColorOverrides}
      />

      <GraphToggle value={granularity} onChange={setGranularity} />

      <LeftPanelHeader
        expanded={activeRailDestination != null}
        onCollapse={() => setActiveRailDestination(null)}
      />
      <InspectorRail active={activeRailDestination} onSelect={setActiveRailDestination} />
      {activeRailDestination && (
        <InspectorPanel
          active={activeRailDestination}
          graphContent={
            <MusicMapSettings settings={settings} updateSettings={updateSettings} granularity={granularity} />
          }
        >
          <CollectionPanel
            anchorNodeId={anchorNodeId}
            onSelectNode={selectAndFly}
            onOpenMaintenance={() => setHygieneOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </InspectorPanel>
      )}

      <RightPanelHeader expanded={rightPanelExpanded} onCollapse={() => setRightPanelExpanded(false)} />
      {/* Now playing, and only now playing. Selection used to take this
       * panel over (P-5's "one node-detail surface"), which meant looking at
       * anything cost you sight of what was playing; the selected node now
       * has its own surface on the canvas, and the deeper half of P-5's
       * argument survives inside NodeDetailPages — one component renders a
       * node's detail for both this panel and the inspector. */}
      <RightPanel
        expanded={rightPanelExpanded}
        collapsedNodeId={playback.status.currentRecordingNodeId ?? null}
        onExpand={() => setRightPanelExpanded(true)}
      >
        <NowPlayingPanel
          nodeId={playback.status.currentRecordingNodeId ?? null}
          isPlaying={playback.status.currentRecordingNodeId != null}
          upNext={playback.upNext}
          onSelectNode={selectAndFly}
          onPlay={playback.playNode}
        />
      </RightPanel>

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
