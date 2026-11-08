import Graph from 'graphology'
import { describe, expect, it } from 'vitest'
import { boxOf, drawnKeys, hiddenByShow } from './drawnNodes'

/* #482: an Insights path shown on the map lights and frames only what the
 * map draws. Harbour Lights (1) was produced by Mara Quinn (2), who produced
 * Velvet Signals (3), on the label Iron Coast (4) with Paper Towers (5).
 * Tracks 11 and 12 tie each artist to the producer. */

const ALL_SHOWN = { showArtists: true, showReleases: true, showTracks: true }
const PATH = ['1', '2', '3', '4', '5', '11', '12']

/** The graph as Canvas's syncGraph leaves it: producers only while they're
 * shown, and never a label, which has no place on the map. */
function mapGraph({ producersShown }: { producersShown: boolean }): Graph {
  const graph = new Graph({ multi: true })
  const add = (key: string, nodeType: string, x: number, y: number) => graph.addNode(key, { nodeType, x, y })
  add('1', 'artist', 0, 0)
  add('3', 'artist', 10, 0)
  add('5', 'artist', 20, 10)
  add('11', 'recording', 2, 1)
  add('12', 'recording', 8, 1)
  if (producersShown) add('2', 'credit', 5, -30)
  return graph
}

const identity = (p: { x: number; y: number }) => p

describe('what a focus lights and frames on the map', () => {
  it('leaves out a producer the map options hide, and frames the drawn nodes only', () => {
    const graph = mapGraph({ producersShown: false })
    const keys = drawnKeys(graph, PATH, ALL_SHOWN)
    expect([...keys]).toEqual(['1', '3', '5', '11', '12'])
    expect(boxOf(graph, keys, identity)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 10 })
  })

  it('leaves out a label, which the map never draws', () => {
    const graph = mapGraph({ producersShown: false })
    const keys = drawnKeys(graph, ['3', '4', '5'], ALL_SHOWN)
    expect([...keys]).toEqual(['3', '5'])
    expect(boxOf(graph, keys, identity)).toEqual({ minX: 10, minY: 0, maxX: 20, maxY: 10 })
  })

  it('lights and frames the producer like any other node once producers are shown', () => {
    const graph = mapGraph({ producersShown: true })
    const keys = drawnKeys(graph, PATH, ALL_SHOWN)
    expect([...keys]).toEqual(['1', '2', '3', '5', '11', '12'])
    expect(boxOf(graph, keys, identity)).toEqual({ minX: 0, minY: -30, maxX: 20, maxY: 10 })
  })

  it('leaves out a kind the show chips hide, though the graph keeps it', () => {
    const graph = mapGraph({ producersShown: true })
    graph.mergeNodeAttributes('12', { x: 500, y: 500 })
    const keys = drawnKeys(graph, PATH, { ...ALL_SHOWN, showTracks: false })
    expect([...keys]).toEqual(['1', '2', '3', '5'])
    // The hidden track's far-off place doesn't widen the frame.
    expect(boxOf(graph, keys, identity)).toEqual({ minX: 0, minY: -30, maxX: 20, maxY: 10 })
  })

  it('has no box when the map draws none of them', () => {
    const graph = mapGraph({ producersShown: false })
    expect(boxOf(graph, drawnKeys(graph, ['2', '4'], ALL_SHOWN), identity)).toBeNull()
  })

  it('hides each kind only by its own chip', () => {
    expect(hiddenByShow('artist', { ...ALL_SHOWN, showArtists: false })).toBe(true)
    expect(hiddenByShow('release', { ...ALL_SHOWN, showReleases: false })).toBe(true)
    expect(hiddenByShow('recording', { ...ALL_SHOWN, showTracks: false })).toBe(true)
    expect(hiddenByShow('artist', { ...ALL_SHOWN, showTracks: false })).toBe(false)
    expect(hiddenByShow('credit', { showArtists: false, showReleases: false, showTracks: false })).toBe(false)
  })
})
