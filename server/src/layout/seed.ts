import type Database from "better-sqlite3";
import { getAlbumLabelMap } from "../entities/collaboration.js";
import { pickMode } from "../entities/mode.js";
import { computeClusteredSeeds, type ClusterInput, type Seed } from "./cluster.js";

export type { Seed };

function decadeOf(year: number | null): number | null {
  return year == null || Number.isNaN(year) ? null : Math.floor(year / 10) * 10;
}

// seed_version only bumps when the computed position actually differs — a
// no-op recompute (nothing about the underlying data changed) must leave
// the row byte-identical, not just numerically equal. granularity is part
// of the conflict key (migration 0015): the same node can hold up to three
// independent seed positions, one per graph it appears in.
function upsertSeeds(db: Database.Database, granularity: "tracks" | "albums" | "artists", seeds: Map<number, Seed>): void {
  const upsert = db.prepare(
    `INSERT INTO positions (node_id, granularity, seed_x, seed_y, seed_version) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(node_id, granularity) DO UPDATE SET
       seed_version = CASE
         WHEN positions.seed_x = excluded.seed_x AND positions.seed_y = excluded.seed_y
         THEN positions.seed_version ELSE positions.seed_version + 1
       END,
       seed_x = excluded.seed_x, seed_y = excluded.seed_y`,
  );
  const applyAll = db.transaction(() => {
    for (const [nodeId, seed] of seeds) upsert.run(nodeId, granularity, seed.x, seed.y);
  });
  applyAll();
}

// Recording nodes only — the tracks graph used to also carry every
// artist/release/label/credit/year node a recording connected to (a
// centroid of its neighbors' positions), but that made the "tracks" tab
// show the whole mixed library rather than just tracks. Positioned by
// deterministic cell assignment (primary artist, falling back to label,
// falling back to unclustered) crossed with decade, then local force
// relaxation within each cell — replacing the old plain (decade, year)
// grid pack, which is what actually overplotted on the real library (see
// Legato.md: same-artist albums landing at near-identical centroids with
// overlapping covers).
export function recomputeTracksLayout(db: Database.Database): void {
  const recordingRows = db
    .prepare(
      `SELECT n.id AS node_id,
              (SELECT CAST(y.title AS INTEGER) FROM edges e
                 JOIN nodes y ON y.id = e.to_node
                WHERE e.from_node = n.id AND e.type = 'released_in' LIMIT 1) AS year,
              (SELECT e.to_node FROM edges e
                WHERE e.from_node = n.id AND e.type = 'performed_by'
                ORDER BY e.id LIMIT 1) AS artist_id,
              (SELECT e.to_node FROM edges e
                WHERE e.from_node = n.id AND e.type = 'released_on' LIMIT 1) AS label_id
       FROM nodes n
       WHERE n.type = 'recording'
         AND EXISTS (SELECT 1 FROM files f WHERE f.recording_node_id = n.id)`,
    )
    .all() as { node_id: number; year: number | null; artist_id: number | null; label_id: number | null }[];

  const clusterInputs: ClusterInput[] = recordingRows.map((r) => ({
    nodeId: r.node_id,
    groupKey: r.artist_id ?? r.label_id,
    decade: decadeOf(r.year),
  }));
  const seeds = computeClusteredSeeds(clusterInputs);

  upsertSeeds(db, "tracks", seeds);

  // Installs that ran a recompute before the satellite-node centroid
  // seeding above was removed still have stale artist/release/label/year
  // rows sitting under granularity = 'tracks' — upsertSeeds only ever
  // inserts/updates the recording set above, it never deletes what it
  // didn't write, so those rows would otherwise linger forever.
  db.prepare(
    `DELETE FROM positions WHERE granularity = 'tracks'
       AND node_id NOT IN (SELECT id FROM nodes WHERE type = 'recording')`,
  ).run();
}

// Album entities only, connected to each other via same_artist/same_label
// edges (entities/collaboration.ts) — a distinct graph, not the tracks
// graph filtered down. Clustered by the same artist/label affinity as the
// tracks graph, one level up: primary artist if known, else the release's
// own dominant label; positioned chronologically by year_min.
export function recomputeAlbumsLayout(db: Database.Database): void {
  const albums = db
    .prepare("SELECT node_id, primary_artist_node_id, year_min FROM albums")
    .all() as { node_id: number; primary_artist_node_id: number | null; year_min: number | null }[];

  const albumLabel = getAlbumLabelMap(db);

  const clusterInputs: ClusterInput[] = albums.map((a) => ({
    nodeId: a.node_id,
    groupKey: a.primary_artist_node_id ?? albumLabel.get(a.node_id) ?? null,
    decade: decadeOf(a.year_min),
  }));

  upsertSeeds(db, "albums", computeClusteredSeeds(clusterInputs));
}

// Artist entities only, connected to each other via collaborated_with
// edges. Neither "primary artist" nor "decade" apply to an artist itself,
// so both axes are derived one level up from their own albums: clustered
// by their most common label across every release they're the primary
// artist on, positioned at the decade of their earliest release.
export function recomputeArtistsLayout(db: Database.Database): void {
  const artists = db.prepare("SELECT node_id FROM artists").all() as { node_id: number }[];
  const albums = db
    .prepare("SELECT node_id, primary_artist_node_id, year_min FROM albums WHERE primary_artist_node_id IS NOT NULL")
    .all() as { node_id: number; primary_artist_node_id: number; year_min: number | null }[];

  const albumLabel = getAlbumLabelMap(db);

  const albumsByArtist = new Map<number, typeof albums>();
  for (const album of albums) {
    const list = albumsByArtist.get(album.primary_artist_node_id);
    if (list) list.push(album);
    else albumsByArtist.set(album.primary_artist_node_id, [album]);
  }

  const clusterInputs: ClusterInput[] = artists.map((artist) => {
    const own = albumsByArtist.get(artist.node_id) ?? [];

    const labelCounts = new Map<number, number>();
    for (const album of own) {
      const labelId = albumLabel.get(album.node_id);
      if (labelId != null) labelCounts.set(labelId, (labelCounts.get(labelId) ?? 0) + 1);
    }

    const years = own.map((a) => a.year_min).filter((y): y is number => y != null);
    const earliestYear = years.length > 0 ? Math.min(...years) : null;

    return { nodeId: artist.node_id, groupKey: pickMode(labelCounts), decade: decadeOf(earliestYear) };
  });

  upsertSeeds(db, "artists", computeClusteredSeeds(clusterInputs));
}

// user_x/user_y are never touched by any of these — only a PATCH
// /nodes/:id/position request (scoped to one granularity) writes them.
export function recomputeAllLayouts(db: Database.Database): void {
  recomputeTracksLayout(db);
  recomputeAlbumsLayout(db);
  recomputeArtistsLayout(db);
}
