import type Database from "better-sqlite3";
import { fetchLrclibLyrics } from "./lrclib.js";

export type LyricsResponse = {
  plainLyrics: string | null;
  syncedLyrics: string | null;
  instrumental: boolean;
  found: boolean;
};

function edgeTargetTitle(db: Database.Database, fromNode: number, type: string): string | null {
  const row = db
    .prepare(`SELECT n.title FROM edges e JOIN nodes n ON n.id = e.to_node WHERE e.from_node = ? AND e.type = ? LIMIT 1`)
    .get(fromNode, type) as { title: string } | undefined;
  return row?.title ?? null;
}

const NOT_FOUND: LyricsResponse = { plainLyrics: null, syncedLyrics: null, instrumental: false, found: false };

// Cached wholesale per node_id, unlike articles/similarity which recompute
// on every scan — a fetch only happens the first time someone opens a
// track's lyrics page, and the result (found or not) never changes on its
// own, so there is nothing to invalidate on a re-scan.
//
// Returns null only when nodeId isn't a real recording — every other case
// (no artist to search with, LRCLIB has nothing, LRCLIB has it) resolves to
// a real LyricsResponse, found:false covering the first two.
export async function getLyrics(db: Database.Database, nodeId: number): Promise<LyricsResponse | null> {
  const cached = db
    .prepare("SELECT plain_lyrics, synced_lyrics, instrumental, found FROM lyrics WHERE node_id = ?")
    .get(nodeId) as
    | { plain_lyrics: string | null; synced_lyrics: string | null; instrumental: number; found: number }
    | undefined;
  if (cached) {
    return {
      plainLyrics: cached.plain_lyrics,
      syncedLyrics: cached.synced_lyrics,
      instrumental: cached.instrumental === 1,
      found: cached.found === 1,
    };
  }

  const node = db.prepare("SELECT id FROM nodes WHERE id = ? AND type = 'recording'").get(nodeId);
  if (!node) return null;

  const artistTitle = edgeTargetTitle(db, nodeId, "performed_by");
  if (!artistTitle) return NOT_FOUND; // LRCLIB requires an artist name to search on; not cached — a later enrichment pass may add one

  const recordingTitle = (db.prepare("SELECT title FROM nodes WHERE id = ?").get(nodeId) as { title: string }).title;
  const albumTitle = edgeTargetTitle(db, nodeId, "appears_on");
  const recording = db.prepare("SELECT canonical_duration_ms FROM recordings WHERE node_id = ?").get(nodeId) as
    | { canonical_duration_ms: number | null }
    | undefined;

  const result = await fetchLrclibLyrics({
    trackName: recordingTitle,
    artistName: artistTitle,
    albumName: albumTitle,
    durationSec: recording?.canonical_duration_ms != null ? Math.round(recording.canonical_duration_ms / 1000) : null,
  });

  const response: LyricsResponse = result ? { ...result, found: true } : NOT_FOUND;
  db.prepare(
    `INSERT INTO lyrics (node_id, plain_lyrics, synced_lyrics, instrumental, found)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET plain_lyrics = excluded.plain_lyrics, synced_lyrics = excluded.synced_lyrics,
       instrumental = excluded.instrumental, found = excluded.found, fetched_at = datetime('now')`,
  ).run(nodeId, response.plainLyrics, response.syncedLyrics, response.instrumental ? 1 : 0, response.found ? 1 : 0);

  return response;
}
