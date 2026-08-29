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
import { TransportDock } from './shell/TransportDock'
import { CollectionPanel, type CollectionPanelHandle } from './panels/CollectionPanel'
import { MusicMapSettings } from './panels/MusicMapSettings'
import { LegatoSettings } from './panels/LegatoSettings'
import { SERVER_HOST } from './config/serverHost'
import { NowPlayingPanel } from './panels/NowPlayingPanel'
import { NodeInspector } from './panels/NodeInspector'
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
  // The rail's own selection doubles as the left shell's expand/collapse
  // state — "exactly one active at a time, or none when collapsed" is
  // literally what DESIGN.md's shell section specifies, so there is no
  // separate boolean to keep in sync with it. The right (now-playing) side
  // collapses independently, via its own header icon — the two sides never
  // shared a single collapse state in the mockup to begin with, only a
  // shared *concept* of one. Both default open, matching today's baseline.
  const [activeRailDestination, setActiveRailDestination] = useState<RailDestination | null>('search')
  const [rightPanelExpanded, setRightPanelExpanded] = useState(true)
  // The left header's collapsed-state expand icon (Figma's later "Panel
  // Collapse" revision, node 66:85 — see DESIGN.md "Panel collapsed (v2)")
  // has no destination of its own to open, unlike a rail icon click. This
  // remembers whichever destination was active before collapsing so the
  // header button restores it, rather than forcing back to 'search' every
  // time.
  const lastRailDestinationRef = useRef<RailDestination>('search')
  const { settings, updateSettings } = useSettings()
  const replaygainMode = (settings.replaygainMode as ReplayGainMode) || 'track'
  const playback = usePlayback(replaygainMode)
  const canvasRef = useRef<CanvasHandle>(null)
  const collectionPanelRef = useRef<CollectionPanelHandle>(null)

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
  // looking at the canvas shows up immediately. edgeColorOverrides is
  // memoized so its identity is stable across renders that don't touch any
  // edgeColor:* key — Canvas re-reads it (and calls renderer.refresh()) on
  // every identity change.
  const nodeSizeMultiplier = Number(settings.nodeSizeMultiplier ?? '1')
  const edgeThicknessMultiplier = Number(settings.edgeThicknessMultiplier ?? '1')
  const showArtistArt = settings.showImagesArtists !== 'false'
  const showReleaseArt = settings.showImagesAlbums !== 'false'
  const showTrackArt = settings.showImagesTracks !== 'false'
  const edgeColorOverrides = useMemo(() => resolveEdgeColorOverrides(settings), [settings])

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
  }, [inspectorOpen, hygieneOpen, playback])

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
        showArtistArt={showArtistArt}
        showReleaseArt={showReleaseArt}
        showTrackArt={showTrackArt}
        nodeSizeMultiplier={nodeSizeMultiplier}
        edgeThicknessMultiplier={edgeThicknessMultiplier}
        edgeColorOverrides={edgeColorOverrides}
        nodesLocked={nodesLocked}
        forceCenterStrength={forceCenterStrength}
        forceRepelStrength={forceRepelStrength}
        forceLinkStrength={forceLinkStrength}
        linkDistance={linkDistance}
      />

      <LeftPanelHeader
        expanded={activeRailDestination != null}
        onCollapse={() => setActiveRailDestination(null)}
        onExpand={() => setActiveRailDestination(lastRailDestinationRef.current)}
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
          graphContent={<MusicMapSettings settings={settings} updateSettings={updateSettings} />}
          settingsContent={
            <LegatoSettings settings={settings} updateSettings={updateSettings} onSetAudioDevice={playback.setAudioDevice} />
          }
        >
          <CollectionPanel
            ref={collectionPanelRef}
            anchorNodeId={anchorNodeId}
            onSelectNode={selectAndFly}
            onOpenMaintenance={() => setHygieneOpen(true)}
          />
        </InspectorPanel>
      )}

      <RightPanelHeader
        expanded={rightPanelExpanded}
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
