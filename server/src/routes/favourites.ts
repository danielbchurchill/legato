import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { broadcast } from "../ws.js";

// The Favourites rail destination's whole API: a flat, manually-curated
// list — no matching, no inference, nothing derived from play history.
// See migration 0020 and Legato-Stage-Four-Rail-Gaps.md "1. Favourites" for
// why this is deliberately separate from both playlists and "top played".

export type FavouriteRow = { id: number; type: string; title: string };

// Recency, not alphabetical — a favourites list is "what did I just find",
// not a library index (see 0020_favourites.sql's rationale).
export function listFavourites(db: Database): FavouriteRow[] {
  return db
    .prepare(
      `SELECT n.id, n.type, n.title
       FROM favourites f
       JOIN nodes n ON n.id = f.node_id
       ORDER BY f.created_at DESC`,
    )
    .all() as FavouriteRow[];
}

// Idempotent — the frontend flips its heart optimistically before this
// resolves, so a stale double-click landing here twice must not error.
export function addFavourite(db: Database, nodeId: number): void {
  db.prepare("INSERT OR IGNORE INTO favourites (node_id) VALUES (?)").run(nodeId);
}

export function removeFavourite(db: Database, nodeId: number): void {
  db.prepare("DELETE FROM favourites WHERE node_id = ?").run(nodeId);
}

export function favouritesRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/favourites", async () => listFavourites(db));

    app.post<{ Params: { nodeId: string } }>("/favourites/:nodeId", async (request) => {
      const nodeId = Number(request.params.nodeId);
      addFavourite(db, nodeId);
      broadcast("favourites:changed", { nodeId });
      return { ok: true };
    });

    app.delete<{ Params: { nodeId: string } }>("/favourites/:nodeId", async (request) => {
      const nodeId = Number(request.params.nodeId);
      removeFavourite(db, nodeId);
      broadcast("favourites:changed", { nodeId });
      return { ok: true };
    });
  };
}
