import type { Database } from "../sqlite.js";

// Issue #273: one person, one node. Until this, producer, engineer and
// performer credits were 'credit' nodes and performers were 'artist' nodes,
// so a person credited both ways was two nodes: Bob Dylan was artist node 2
// for his own tracks and credit node 16 for MusicBrainz's performer and
// producer credits on them, twice on the map and twice in search. New
// credits land on the artist node already (findOrCreatePerson in
// match/edges.ts). This merges the pairs that exist, and any the
// membership crawl (enrich/members.ts, which only looks for artist nodes)
// creates later. recompute.ts runs it after every scan and index.ts on
// every start, and it costs one indexed query when there is nothing to do.

type NodeReference = { table: string; column: string };

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// Every column that holds a node id, read from the schema's own foreign
// keys rather than listed here, so a table added by a later migration is
// carried along by a merge without anyone remembering to add it.
function nodeReferences(db: Database): NodeReference[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const references: NodeReference[] = [];
  for (const { name } of tables) {
    const keys = db
      .prepare(`SELECT "table" AS target, "from" AS fromColumn, "to" AS toColumn FROM pragma_foreign_key_list(?)`)
      .all(name) as { target: string; fromColumn: string; toColumn: string | null }[];
    for (const key of keys) {
      if (key.target === "nodes" && (key.toColumn === null || key.toColumn === "id")) {
        references.push({ table: name, column: key.fromColumn });
      }
    }
  }
  return references;
}

/** Folds node `fromId` into node `intoId` and deletes it. Every row that
 *  points at `fromId` moves to `intoId`. A row that would collide with one
 *  `intoId` already has (a second favourite, a second article, a second
 *  map position) is dropped, so the survivor's own wins. Two exceptions
 *  carry user data across anyway: a position the user dragged moves onto
 *  a survivor that was only ever seeded, and a manual edge beats a derived
 *  copy of itself. */
export function mergeNodeInto(
  db: Database,
  fromId: number,
  intoId: number,
  references: NodeReference[] = nodeReferences(db),
): void {
  if (fromId === intoId) return;

  db.transaction(() => {
    // A lookup is about the node it was queued for, and a done one would
    // stop the same lookup being queued for the survivor. recompute.ts
    // queues whatever the survivor still needs.
    db.prepare("DELETE FROM enrich_jobs WHERE node_id = ?").run(fromId);

    db.prepare(
      `UPDATE positions SET
         user_x = (SELECT p.user_x FROM positions p WHERE p.node_id = ? AND p.granularity = positions.granularity),
         user_y = (SELECT p.user_y FROM positions p WHERE p.node_id = ? AND p.granularity = positions.granularity)
       WHERE node_id = ? AND user_x IS NULL
         AND EXISTS (SELECT 1 FROM positions p
                      WHERE p.node_id = ? AND p.granularity = positions.granularity AND p.user_x IS NOT NULL)`,
    ).run(fromId, fromId, intoId, fromId);

    const moved = new Set(
      (
        db.prepare("SELECT id FROM edges WHERE from_node = ? OR to_node = ?").all(fromId, fromId) as { id: number }[]
      ).map((r) => r.id),
    );

    for (const { table, column } of references) {
      db.prepare(`UPDATE OR IGNORE ${quote(table)} SET ${quote(column)} = ? WHERE ${quote(column)} = ?`).run(
        intoId,
        fromId,
      );
      // Only rows a unique key kept from moving are left by now.
      db.prepare(`DELETE FROM ${quote(table)} WHERE ${quote(column)} = ?`).run(fromId);
    }

    // A connection between the two nodes is now one from the survivor to
    // itself.
    db.prepare("DELETE FROM edges WHERE from_node = ? AND to_node = ?").run(intoId, intoId);

    // The same tie recorded on both nodes is now recorded twice. The label
    // is part of the tie: two performed_credit edges from one recording,
    // "vocals" and "harmonica", are two credits. Only groups the move
    // created are touched; the survivor's own edges stay as they were.
    const edges = db
      .prepare(
        "SELECT id, from_node, to_node, type, label, source FROM edges WHERE from_node = ? OR to_node = ? ORDER BY id",
      )
      .all(intoId, intoId) as {
      id: number;
      from_node: number;
      to_node: number;
      type: string;
      label: string | null;
      source: string;
    }[];
    const groups = new Map<string, typeof edges>();
    for (const edge of edges) {
      const key = JSON.stringify([edge.from_node, edge.to_node, edge.type, edge.label]);
      groups.set(key, [...(groups.get(key) ?? []), edge]);
    }
    const remove = db.prepare("DELETE FROM edges WHERE id = ?");
    for (const group of groups.values()) {
      if (group.length < 2 || !group.some((edge) => moved.has(edge.id))) continue;
      const keep = group.find((edge) => edge.source === "manual") ?? group[0];
      for (const edge of group) if (edge !== keep) remove.run(edge.id);
    }

    db.prepare("DELETE FROM nodes WHERE id = ?").run(fromId);
  })();
}

/** For a node named after a credit line that has split
 *  (match/edges.ts): what enrichment found under the whole line's name (a
 *  photo, a paragraph, an MBID) is about a name that's gone, not the artist
 *  taking its place, so it's dropped. The user's favourite, connections,
 *  position and a cover they chose themselves still move. */
export function retireNodeInto(db: Database, fromId: number, intoId: number): void {
  db.transaction(() => {
    db.prepare("DELETE FROM descriptions WHERE node_id = ?").run(fromId);
    db.prepare("DELETE FROM field_provenance WHERE node_id = ?").run(fromId);
    db.prepare("DELETE FROM cover_art WHERE node_id = ? AND source = 'artist_image'").run(fromId);
    mergeNodeInto(db, fromId, intoId);
  })();
}

/** Merges every 'credit' node into the 'artist' node of the same name,
 *  matched the way match/edges.ts matches names (case and outer spaces
 *  ignored). If two artist nodes share the name, which only data from
 *  before that matching can hold, the credit goes to the older one, and
 *  the two artists are left alone. Returns how many credit nodes it
 *  merged. */
export function mergeDuplicatePeople(db: Database): number {
  const pairs = db
    .prepare(
      `SELECT credit_id AS creditId, artist_id AS artistId FROM (
         SELECT c.id AS credit_id,
                (SELECT MIN(a.id) FROM nodes a
                  WHERE a.type = 'artist' AND lower(trim(a.title)) = lower(trim(c.title))) AS artist_id
           FROM nodes c WHERE c.type = 'credit'
       ) WHERE artist_id IS NOT NULL`,
    )
    .all() as { creditId: number; artistId: number }[];

  if (pairs.length === 0) return 0;
  const references = nodeReferences(db);
  db.transaction(() => {
    for (const { creditId, artistId } of pairs) mergeNodeInto(db, creditId, artistId, references);
  })();
  return pairs.length;
}
