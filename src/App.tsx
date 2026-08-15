import { useEffect, useRef, useState } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import PlaybackSpike from './PlaybackSpike'
import LibrarySetup, { Centered } from './LibrarySetup'
import { useServerReady } from './hooks/useServerReady'
import Canvas, { type CanvasHandle } from './canvas/Canvas'
import ArticlePanel from './canvas/ArticlePanel'
import { usePlayback } from './playback/usePlayback'
import HygieneView from './hygiene/HygieneView'
import { AppShell } from './shell/AppShell'
import { Panel } from './shell/Panel'
import { GraphToggle } from './shell/GraphToggle'
import type { Granularity } from './shell/granularity'
import { TransportDock } from './shell/TransportDock'
import { CollectionPanel } from './panels/CollectionPanel'
import { NowPlayingPanel } from './panels/NowPlayingPanel'
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [granularity, setGranularity] = useState<Granularity>('albums')
  const { settings, updateSettings } = useSettings()
  const replaygainMode = (settings.replaygainMode as ReplayGainMode) || 'track'
  const playback = usePlayback(replaygainMode)
  const canvasRef = useRef<CanvasHandle>(null)

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

  useEffect(() => {
    fetch('http://127.0.0.1:8899/api/v1/library-roots')
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
        onSelectNode={setSelectedNodeId}
      />

      <GraphToggle value={granularity} onChange={setGranularity} />

      <Panel side="left" title="collection">
        <CollectionPanel
          anchorNodeId={anchorNodeId}
          onSelectNode={selectAndFly}
          onOpenMaintenance={() => setHygieneOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </Panel>

      {/* One panel, two modes: the node you selected takes precedence over
       * what is playing, since selecting is the more recent intent. The
       * dedicated node-detail surface is a later pass. */}
      <Panel side="right" title={selectedNodeId != null ? 'selected' : 'now playing'}>
        {selectedNodeId != null ? (
          <ArticlePanel
            nodeId={selectedNodeId}
            onSelectNode={selectAndFly}
            onClose={() => setSelectedNodeId(null)}
            onPlay={playback.playNode}
          />
        ) : (
          <NowPlayingPanel
            nodeId={playback.status.currentRecordingNodeId}
            status={playback.status}
            upNext={playback.upNext}
            onSelectNode={selectAndFly}
          />
        )}
      </Panel>

      <TransportDock
        status={playback.status}
        hasTrack={playback.currentTitle != null}
        onPause={playback.pause}
        onResume={playback.resume}
        onSeek={playback.seek}
        onSetVolume={playback.setVolume}
      />

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
  const serverReady = useServerReady()
  const debug = new URLSearchParams(window.location.search).has('debug')

  if (!serverReady) {
    return <Centered>starting legato-server…</Centered>
  }

  return debug ? <DebugSpikes /> : <MainApp />
}
