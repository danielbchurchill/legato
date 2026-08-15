import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getOrComputePeaks } from "../waveform/peaks.js";

export function waveformRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    // On-demand fallback for anything the scan's inline pass missed
    // (ensurePeaksForFile is best-effort, non-fatal, same as cover art) —
    // this route computes and caches on the spot rather than 404ing.
    app.get<{ Params: { id: string } }>("/files/:id/peaks", async (request, reply) => {
      const fileId = Number(request.params.id);
      if (!Number.isInteger(fileId)) {
        reply.code(400);
        return { error: "invalid file id" };
      }

      let peaks: number[] | null;
      try {
        peaks = await getOrComputePeaks(db, fileId);
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }

      if (!peaks) {
        reply.code(404);
        return { error: "file not found or not yet hashed" };
      }

      return { peaks };
    });
  };
}
