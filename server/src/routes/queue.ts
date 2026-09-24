import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

type ResolvedTrack = {
  recordingNodeId: number;
  fileId: number;
  filePath: string;
  format: string | null;
  bitrate: number | null;
  durationMs: number | null;
  replaygainTrackGain: number | null;
  replaygainAlbumGain: number | null;
};

// Turns a list of recording node ids into a concrete playback plan — one
// file per node (the best instance among however many a collapsed
// recording has), excluding anything currently missing on disk. Both the
// desktop (native Rust) and remote/WASM playback paths call this same
// route rather than each re-implementing "which file backs this node,"
// per the MVP roadmap's M6 architecture note.
//
// Order matters here in a way most list endpoints don't: this is the
// resolution step behind both a plain "play album" queue and a shuffled
// one (D12, docs/plans/05-listening-and-map.md — shuffle keeps its own
// permutation of recordingNodeIds and hands it straight to this route), so
// `.map()` rather than a join/IN-clause query is deliberate — it's the one
// shape that can't silently re-sort the caller's order out from under it.
export function resolveQueueTracks(db: Database.Database, ids: number[]): (ResolvedTrack | null)[] {
  const stmt = db.prepare(
    `SELECT id, file_path, format, bitrate, duration_ms, replaygain_track_gain, replaygain_album_gain
     FROM files
     WHERE recording_node_id = ? AND missing_since IS NULL
     ORDER BY bitrate DESC, id ASC
     LIMIT 1`,
  );

  return ids.map((nodeId) => {
    const file = stmt.get(nodeId) as
      | {
          id: number;
          file_path: string;
          format: string | null;
          bitrate: number | null;
          duration_ms: number | null;
          replaygain_track_gain: number | null;
          replaygain_album_gain: number | null;
        }
      | undefined;
    if (!file) return null;
    return {
      recordingNodeId: nodeId,
      fileId: file.id,
      filePath: file.file_path,
      format: file.format,
      bitrate: file.bitrate,
      durationMs: file.duration_ms,
      replaygainTrackGain: file.replaygain_track_gain,
      replaygainAlbumGain: file.replaygain_album_gain,
    };
  });
}

export function queueRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.post<{ Body: { recordingNodeIds: number[] } }>("/queue/resolve", async (request, reply) => {
      const ids = request.body?.recordingNodeIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        reply.code(400);
        return { error: "recordingNodeIds must be a non-empty array" };
      }

      return { tracks: resolveQueueTracks(db, ids) };
    });
  };
}
