import type { Database } from "../sqlite.js";
import { writeInChunks } from "../writeInChunks.js";
import {
  generateArtistArticle,
  generateCreditArticle,
  generateLabelArticle,
  generateRecordingArticle,
  generateReleaseArticle,
  type NodeRef,
} from "./generate.js";

// Issue #281: one prepared statement per query for the whole pass, rather
// than one per query per node. Preparing them again for each of 180,000
// artist nodes was most of this pass's time on the Pi.
type Prepare = (sql: string) => ReturnType<Database["prepare"]>;

function statementCache(db: Database): Prepare {
  const statements = new Map<string, ReturnType<Database["prepare"]>>();
  return (sql) => {
    let statement = statements.get(sql);
    if (!statement) statements.set(sql, (statement = db.prepare(sql)));
    return statement;
  };
}

// Every edge out of a recording, in one query rather than one per type.
// Ordered by edge id so the first of a type means "the first credited
// one" — a multi-artist recording has several performed_by edges and an
// article that named an arbitrary one would churn between recomputes.
function edgeTargetsByType(prepare: Prepare, fromNode: number): Map<string, NodeRef[]> {
  const byType = new Map<string, NodeRef[]>();
  const rows = prepare(
    `SELECT e.type, n.id, n.title FROM edges e JOIN nodes n ON n.id = e.to_node
      WHERE e.from_node = ? ORDER BY e.id`,
  ).all(fromNode) as (NodeRef & { type: string })[];
  for (const { type, id, title } of rows) {
    const targets = byType.get(type);
    if (targets) targets.push({ id, title });
    else byType.set(type, [{ id, title }]);
  }
  return byType;
}

function recordingArticle(prepare: Prepare, nodeId: number): string | null {
  const targets = edgeTargetsByType(prepare, nodeId);
  const edgeTargets = (type: string) => targets.get(type) ?? [];
  const edgeTarget = (type: string) => edgeTargets(type)[0] ?? null;
  const artist = edgeTarget("performed_by");
  const release = edgeTarget("appears_on");
  const yearNode = edgeTarget("released_in");
  const year = yearNode ? Number(yearNode.title) : null;
  const label = edgeTarget("released_on");
  const producers = edgeTargets("produced_by");
  const engineers = edgeTargets("engineered_by");
  const featuredArtists = edgeTargets("featured_artist");

  const siblingCount = release
    ? ((prepare("SELECT COUNT(*) AS n FROM edges WHERE to_node = ? AND type = 'appears_on' AND from_node != ?").get(
        release.id,
        nodeId,
      ) as { n: number }).n)
    : 0;

  return generateRecordingArticle({
    artist,
    release,
    year: year != null && !Number.isNaN(year) ? year : null,
    label,
    producers,
    engineers,
    featuredArtists,
    siblingCount,
  });
}

function artistArticle(prepare: Prepare, nodeId: number): string | null {
  const row = prepare("SELECT track_count, album_count FROM artists WHERE node_id = ?").get(nodeId) as
    | { track_count: number; album_count: number }
    | undefined;

  // label IS NULL restricts this to real ties (entities/collaboration.ts's
  // computeArtistCollaborations — actually shared a recording), excluding
  // the G-7 affinity edges (same label/era/producer) that share the same
  // collaborated_with type for graph-clustering purposes but never mean
  // these two artists actually worked together — "Has collaborated with"
  // would otherwise be a false claim about artists with no real tie.
  const collaborators = prepare(
      `SELECT n.id, n.title FROM edges e
       JOIN nodes n ON n.id = (CASE WHEN e.from_node = ? THEN e.to_node ELSE e.from_node END)
       WHERE e.type = 'collaborated_with' AND e.label IS NULL AND (e.from_node = ? OR e.to_node = ?)`,
    )
    .all(nodeId, nodeId, nodeId) as NodeRef[];

  return generateArtistArticle({
    trackCount: row?.track_count ?? 0,
    albumCount: row?.album_count ?? 0,
    collaborators,
  });
}

function releaseArticle(prepare: Prepare, nodeId: number): string | null {
  const row = prepare(
      `SELECT primary_artist_node_id, track_count, total_duration_ms, year_min, year_max FROM albums WHERE node_id = ?`,
    )
    .get(nodeId) as
    | {
        primary_artist_node_id: number | null;
        track_count: number;
        total_duration_ms: number;
        year_min: number | null;
        year_max: number | null;
      }
    | undefined;
  if (!row) return null;

  const primaryArtist = row.primary_artist_node_id
    ? (prepare("SELECT id, title FROM nodes WHERE id = ?").get(row.primary_artist_node_id) as NodeRef)
    : null;

  const sameArtistAlbums = prepare(
      `SELECT n.id, n.title FROM edges e
       JOIN nodes n ON n.id = (CASE WHEN e.from_node = ? THEN e.to_node ELSE e.from_node END)
       WHERE e.type = 'same_artist' AND (e.from_node = ? OR e.to_node = ?)`,
    )
    .all(nodeId, nodeId, nodeId) as NodeRef[];
  const sameLabelAlbums = prepare(
      `SELECT n.id, n.title FROM edges e
       JOIN nodes n ON n.id = (CASE WHEN e.from_node = ? THEN e.to_node ELSE e.from_node END)
       WHERE e.type = 'same_label' AND (e.from_node = ? OR e.to_node = ?)`,
    )
    .all(nodeId, nodeId, nodeId) as NodeRef[];

  return generateReleaseArticle({
    primaryArtist,
    trackCount: row.track_count,
    totalDurationMs: row.total_duration_ms,
    yearMin: row.year_min,
    yearMax: row.year_max,
    sameArtistAlbums,
    sameLabelAlbums,
  });
}

function labelArticle(prepare: Prepare, nodeId: number): string | null {
  const recordings = prepare(`SELECT n.id, n.title FROM edges e JOIN nodes n ON n.id = e.from_node WHERE e.to_node = ? AND e.type = 'released_on'`)
    .all(nodeId) as NodeRef[];
  const artistCount = (
    prepare(
        `SELECT COUNT(DISTINCT pb.to_node) AS n
         FROM edges label
         JOIN edges pb ON pb.from_node = label.from_node AND pb.type = 'performed_by'
         WHERE label.to_node = ? AND label.type = 'released_on'`,
      )
      .get(nodeId) as { n: number }
  ).n;

  return generateLabelArticle({ recordings, artistCount });
}

function creditArticle(prepare: Prepare, nodeId: number): string | null {
  const producedRecordings = prepare(`SELECT n.id, n.title FROM edges e JOIN nodes n ON n.id = e.from_node WHERE e.to_node = ? AND e.type = 'produced_by'`)
    .all(nodeId) as NodeRef[];
  const engineeredRecordings = prepare(`SELECT n.id, n.title FROM edges e JOIN nodes n ON n.id = e.from_node WHERE e.to_node = ? AND e.type = 'engineered_by'`)
    .all(nodeId) as NodeRef[];

  return generateCreditArticle({ producedRecordings, engineeredRecordings });
}

// Recomputed wholesale after every scan, same pattern as entities/
// aggregate.ts, entities/collaboration.ts, and similarity/similarity.ts —
// cheap at real-library scale, and the whole invalidation story: nothing
// to go stale between recomputes. work/year nodes get no article (nothing
// in generate.ts handles them) — a "year" page would just repeat the
// released_in facts.ts already lists, not add anything.
//
// Issue #281: every article is still generated, but outside any
// transaction, and only one that came out different from the stored copy
// is written, in pieces (writeInChunks.ts). This used to write every
// article inside one transaction, which held the write lock for the whole
// pass: 3.5 s on a database the Pi's size before #269's prune.
export function recomputeArticles(db: Database): void {
  const nodes = db.prepare("SELECT id, type FROM nodes WHERE type IN ('recording','artist','release','label','credit')").all() as {
    id: number;
    type: string;
  }[];
  const stored = new Map(
    (
      db
        .prepare(
          `SELECT a.node_id AS nodeId, a.body_md AS body FROM articles a JOIN nodes n ON n.id = a.node_id
            WHERE n.type IN ('recording','artist','release','label','credit')`,
        )
        .all() as { nodeId: number; body: string }[]
    ).map((row) => [row.nodeId, row.body]),
  );

  const prepare = statementCache(db);
  const changed: { nodeId: number; body: string }[] = [];
  for (const node of nodes) {
    let body: string | null;
    switch (node.type) {
      case "recording":
        body = recordingArticle(prepare, node.id);
        break;
      case "artist":
        body = artistArticle(prepare, node.id);
        break;
      case "release":
        body = releaseArticle(prepare, node.id);
        break;
      case "label":
        body = labelArticle(prepare, node.id);
        break;
      case "credit":
        body = creditArticle(prepare, node.id);
        break;
      default:
        body = null;
    }

    if (body && body !== stored.get(node.id)) changed.push({ nodeId: node.id, body });
    if (body) stored.delete(node.id);
  }

  // What's left in `stored` is a node whose generator came back empty.
  const upsert = db.prepare(
    `INSERT INTO articles (node_id, body_md) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET body_md = excluded.body_md, updated_at = datetime('now')`,
  );
  const remove = db.prepare("DELETE FROM articles WHERE node_id = ?");
  writeInChunks(db, changed, ({ nodeId, body }) => upsert.run(nodeId, body));
  writeInChunks(db, stored.keys(), (nodeId) => remove.run(nodeId));
}
