import type Database from "better-sqlite3";
import {
  generateArtistArticle,
  generateCreditArticle,
  generateLabelArticle,
  generateRecordingArticle,
  generateReleaseArticle,
  type NodeRef,
} from "./generate.js";

function edgeTargets(db: Database.Database, fromNode: number, type: string): NodeRef[] {
  return db
    .prepare(
      // Ordered by edge id so edgeTarget() below means "the first credited
      // one" — a multi-artist recording has several performed_by edges and
      // an article that named an arbitrary one would churn between
      // recomputes.
      `SELECT n.id, n.title FROM edges e JOIN nodes n ON n.id = e.to_node
        WHERE e.from_node = ? AND e.type = ? ORDER BY e.id`,
    )
    .all(fromNode, type) as NodeRef[];
}

function edgeTarget(db: Database.Database, fromNode: number, type: string): NodeRef | null {
  return edgeTargets(db, fromNode, type)[0] ?? null;
}

function recordingArticle(db: Database.Database, nodeId: number): string | null {
  const artist = edgeTarget(db, nodeId, "performed_by");
  const release = edgeTarget(db, nodeId, "appears_on");
  const yearNode = edgeTarget(db, nodeId, "released_in");
  const year = yearNode ? Number(yearNode.title) : null;
  const label = edgeTarget(db, nodeId, "released_on");
  const producers = edgeTargets(db, nodeId, "produced_by");
  const engineers = edgeTargets(db, nodeId, "engineered_by");
  const featuredArtists = edgeTargets(db, nodeId, "featured_artist");

  const siblingCount = release
    ? ((db.prepare("SELECT COUNT(*) AS n FROM edges WHERE to_node = ? AND type = 'appears_on' AND from_node != ?").get(
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

function artistArticle(db: Database.Database, nodeId: number): string | null {
  const row = db.prepare("SELECT track_count, album_count FROM artists WHERE node_id = ?").get(nodeId) as
    | { track_count: number; album_count: number }
    | undefined;

  const collaborators = db
    .prepare(
      `SELECT n.id, n.title FROM edges e
       JOIN nodes n ON n.id = (CASE WHEN e.from_node = ? THEN e.to_node ELSE e.from_node END)
       WHERE e.type = 'collaborated_with' AND (e.from_node = ? OR e.to_node = ?)`,
    )
    .all(nodeId, nodeId, nodeId) as NodeRef[];

  return generateArtistArticle({
    trackCount: row?.track_count ?? 0,
    albumCount: row?.album_count ?? 0,
    collaborators,
  });
}

function releaseArticle(db: Database.Database, nodeId: number): string | null {
  const row = db
    .prepare(
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
    ? (db.prepare("SELECT id, title FROM nodes WHERE id = ?").get(row.primary_artist_node_id) as NodeRef)
    : null;

  const sameArtistAlbums = db
    .prepare(
      `SELECT n.id, n.title FROM edges e
       JOIN nodes n ON n.id = (CASE WHEN e.from_node = ? THEN e.to_node ELSE e.from_node END)
       WHERE e.type = 'same_artist' AND (e.from_node = ? OR e.to_node = ?)`,
    )
    .all(nodeId, nodeId, nodeId) as NodeRef[];
  const sameLabelAlbums = db
    .prepare(
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

function labelArticle(db: Database.Database, nodeId: number): string | null {
  const recordings = db
    .prepare(`SELECT n.id, n.title FROM edges e JOIN nodes n ON n.id = e.from_node WHERE e.to_node = ? AND e.type = 'released_on'`)
    .all(nodeId) as NodeRef[];
  const artistCount = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT pb.to_node) AS n
         FROM edges label
         JOIN edges pb ON pb.from_node = label.from_node AND pb.type = 'performed_by'
         WHERE label.to_node = ? AND label.type = 'released_on'`,
      )
      .get(nodeId) as { n: number }
  ).n;

  return generateLabelArticle({ recordings, artistCount });
}

function creditArticle(db: Database.Database, nodeId: number): string | null {
  const producedRecordings = db
    .prepare(`SELECT n.id, n.title FROM edges e JOIN nodes n ON n.id = e.from_node WHERE e.to_node = ? AND e.type = 'produced_by'`)
    .all(nodeId) as NodeRef[];
  const engineeredRecordings = db
    .prepare(`SELECT n.id, n.title FROM edges e JOIN nodes n ON n.id = e.from_node WHERE e.to_node = ? AND e.type = 'engineered_by'`)
    .all(nodeId) as NodeRef[];

  return generateCreditArticle({ producedRecordings, engineeredRecordings });
}

// Recomputed wholesale after every scan, same pattern as entities/
// aggregate.ts, entities/collaboration.ts, and similarity/similarity.ts —
// cheap at real-library scale, and the whole invalidation story: nothing
// to go stale between recomputes. work/year nodes get no article (nothing
// in generate.ts handles them) — a "year" page would just repeat the
// released_in facts.ts already lists, not add anything.
export function recomputeArticles(db: Database.Database): void {
  const nodes = db.prepare("SELECT id, type FROM nodes WHERE type IN ('recording','artist','release','label','credit')").all() as {
    id: number;
    type: string;
  }[];

  const upsert = db.prepare(
    `INSERT INTO articles (node_id, body_md) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET body_md = excluded.body_md, updated_at = datetime('now')`,
  );
  const remove = db.prepare("DELETE FROM articles WHERE node_id = ?");

  const applyAll = db.transaction(() => {
    for (const node of nodes) {
      let body: string | null;
      switch (node.type) {
        case "recording":
          body = recordingArticle(db, node.id);
          break;
        case "artist":
          body = artistArticle(db, node.id);
          break;
        case "release":
          body = releaseArticle(db, node.id);
          break;
        case "label":
          body = labelArticle(db, node.id);
          break;
        case "credit":
          body = creditArticle(db, node.id);
          break;
        default:
          body = null;
      }

      if (body) upsert.run(node.id, body);
      else remove.run(node.id);
    }
  });
  applyAll();
}
