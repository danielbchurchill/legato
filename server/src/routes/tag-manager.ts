import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

/* The Tag Manager rail destination's one job: proactive, library-wide
 * browsing of "which tracks are missing X" — not editing. Clicking a row in
 * the frontend selects+flies to the node so the existing pencil-edit flow
 * (MetadataFields.tsx/useMetadataEditing.ts) handles the actual write. See
 * Legato-Stage-Four-Rail-Gaps.md "3. Tag Manager" for the full scope call.
 */

export type TagManagerField = "bpm" | "label" | "release_date" | "release_type" | "unmatched";
export type TagManagerRow = { id: number; title: string; artist: string | null };

// Column names, not query values, so they're never a placeholder param —
// interpolated directly below, but only ever from this fixed allowlist,
// never from the request's raw query string.
const MISSING_FIELD_COLUMNS: Record<Exclude<TagManagerField, "unmatched">, string> = {
  bpm: "bpm",
  label: "label",
  release_date: "release_date",
  release_type: "release_type",
};

// Same performed_by-edge subquery nodes.ts's GET /nodes uses for the canvas
// hover plate's second line — one artist per node, lowest edge id when a
// recording has more than one credit, so this list never names a different
// artist for the same node than the rest of the app does.
const ARTIST_SUBQUERY = `(SELECT an.title
   FROM edges e JOIN nodes an ON an.id = e.to_node
  WHERE e.from_node = n.id AND e.type = 'performed_by'
  ORDER BY e.id
  LIMIT 1)`;

export function getMissingField(db: Database.Database, field: TagManagerField): TagManagerRow[] {
  if (field === "unmatched") {
    return db
      .prepare(
        `SELECT n.id, n.title, ${ARTIST_SUBQUERY} AS artist
         FROM nodes n
         WHERE n.type = 'recording' AND n.mbid IS NULL
         ORDER BY n.title`,
      )
      .all() as TagManagerRow[];
  }

  const column = MISSING_FIELD_COLUMNS[field];
  // GROUP BY node id: a node with more than one file (a merge case — see
  // InstancesList in MetadataFields.tsx) shouldn't appear twice just
  // because more than one of its files lacks the field.
  return db
    .prepare(
      `SELECT n.id, n.title, ${ARTIST_SUBQUERY} AS artist
       FROM files f
       JOIN nodes n ON n.id = f.recording_node_id
       WHERE f.${column} IS NULL
       GROUP BY n.id
       ORDER BY n.title`,
    )
    .all() as TagManagerRow[];
}

function isValidField(field: string | undefined): field is TagManagerField {
  return field != null && (field === "unmatched" || field in MISSING_FIELD_COLUMNS);
}

export function tagManagerRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { field?: string } }>("/tag-manager", async (request, reply) => {
      const { field } = request.query;
      if (!isValidField(field)) {
        reply.code(400);
        return { error: "field must be one of bpm, label, release_date, release_type, unmatched" };
      }
      return getMissingField(db, field);
    });
  };
}
