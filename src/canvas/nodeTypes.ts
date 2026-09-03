/* Client-side registry of the node types the combined graph actually
 * positions and draws — server/src/layout/seed.ts's recomputeTracksLayout
 * decides this, not an arbitrary list here (kept in sync by hand, same
 * tradeoff edgeTypes.ts already accepts for EDGE_COLOR against
 * routes/nodes.ts's EDGE_TYPES). artist/release/recording have carried
 * positions since the original combined-graph pass (2026-08-29); credit
 * (producer/engineer people — server/src/match/edges.ts's local tags and
 * server/src/enrich/credits.ts's MusicBrainz relations both write these
 * under the shared 'credit' node type) joined once #24 added seeding for
 * it, scoped to nodes with a produced_by or engineered_by edge.
 *
 * label/year/work nodes are real edge targets in the DB (a recording's
 * released_on/released_in/performed_credit edges point at one) but are
 * deliberately excluded here: nothing seeds a position for them, so they
 * never reach the client's /nodes response and have no on-screen size of
 * their own to control. */

export type NodeTypeInfo = { type: string; label: string }

export const NODE_TYPES: NodeTypeInfo[] = [
  { type: 'artist', label: 'artists' },
  { type: 'release', label: 'releases' },
  { type: 'recording', label: 'tracks' },
  { type: 'credit', label: 'producers' },
]

const NODE_SIZE_SETTING_PREFIX = 'nodeSize:'

export function nodeSizeSettingKey(type: string): string {
  return `${NODE_SIZE_SETTING_PREFIX}${type}`
}

/** All `nodeSize:*` settings, keyed back down to a plain type -> multiplier
 * map — what Canvas.tsx's nodeReducer needs live. Missing or non-finite
 * entries fall back to 1 (unchanged), same idiom MusicMapSettings.tsx's own
 * parseMultiplier already uses for every other slider in this panel. */
export function resolveNodeSizeMultipliers(settings: Record<string, string>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const { type } of NODE_TYPES) {
    const raw = settings[nodeSizeSettingKey(type)]
    const n = Number(raw)
    result[type] = raw != null && Number.isFinite(n) ? n : 1
  }
  return result
}
