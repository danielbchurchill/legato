import type { Database } from "../sqlite.js";
import type { FetchedDescription } from "./wikipedia.js";

export type StoredDescription = {
  body: string;
  source: string;
  source_url: string | null;
  license: string | null;
  fetched_at: string;
};

// Only ever returns a description that exists. A row with found = 0 is the
// negative cache — it records that a lookup ran and came back empty, which is
// information the queue needs and the UI must not render as an empty section.
export function getDescription(db: Database, nodeId: number): StoredDescription | null {
  const row = db
    .prepare(
      `SELECT body, source, source_url, license, fetched_at
         FROM descriptions
        WHERE node_id = ? AND found = 1 AND body IS NOT NULL`,
    )
    .get(nodeId) as StoredDescription | undefined;
  return row ?? null;
}

// Writes the outcome of a lookup, found or not. Both are results worth
// keeping: an artist with no encyclopedia article will still have none
// tomorrow, and re-asking on every scan would spend rate-limited requests
// re-learning it (see enrich/queue.ts on why a finished job is never
// automatically retried).
export function recordDescription(
  db: Database,
  nodeId: number,
  source: string,
  description: FetchedDescription | null,
): void {
  db.prepare(
    `INSERT INTO descriptions (node_id, body, source, source_url, license, found)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       body = excluded.body,
       source = excluded.source,
       source_url = excluded.source_url,
       license = excluded.license,
       found = excluded.found,
       fetched_at = datetime('now')`,
  ).run(
    nodeId,
    description?.body ?? null,
    source,
    description?.sourceUrl ?? null,
    description?.license ?? null,
    description ? 1 : 0,
  );
}
