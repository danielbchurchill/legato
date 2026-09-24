import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";

// Strips FTS5 query-syntax characters and turns the rest into a
// prefix-match AND query — safe for arbitrary user input, good enough for
// search-as-you-type at this scale (no ranking tuning beyond FTS5's rank).
function toFtsQuery(raw: string): string | null {
  const cleaned = raw.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!cleaned) return null;
  return cleaned
    .split(/\s+/)
    .map((token) => `${token}*`)
    .join(" ");
}

export function searchRoutes(db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { q?: string; limit?: string } }>("/search", async (request) => {
      const ftsQuery = toFtsQuery(request.query.q ?? "");
      if (!ftsQuery) return [];
      const limit = Math.min(Number(request.query.limit ?? 20), 100);
      return db
        .prepare(
          `SELECT n.id, n.type, n.title
           FROM nodes_fts f JOIN nodes n ON n.id = f.rowid
           WHERE nodes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit);
    });
  };
}
