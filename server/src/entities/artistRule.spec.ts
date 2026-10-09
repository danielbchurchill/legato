import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { recomputeEntities } from "./aggregate.js";
import { recomputeTracksLayout } from "../layout/seed.js";
import { libraryRoutes } from "../routes/library.js";
import { nodesRoutes } from "../routes/nodes.js";
import { computeClusters, type ClusterEdge, type ClusterNode } from "../../../src/canvas/clusters.js";

/* #302: the Library's Artists tab lists the artists the map clusters records
 * under, but the two decide it in different places. The map works it out in
 * the browser from the graph (src/canvas/clusters.ts); the server decides
 * each album's artist at recompute (aggregate.ts) and lists from that
 * (routes/library.ts). Two copies of one rule drift, and a randomized check
 * of the first versions found 886 of 1,000 libraries where they disagreed.
 *
 * So this builds random libraries with what made them differ (a credit node
 * credited ahead of the artist, recordings a collapse left without a file,
 * files gone missing, edge ids out of credit order, hand-drawn appears_on
 * edges to records and to other nodes), and checks that GET /library/artists
 * names the same artists, with the same record counts, as computeClusters
 * over what GET /nodes and GET /edges send the map. A change to one rule
 * that isn't made to the other fails here. */

const LIBRARIES = 150;

// xorshift32: the same libraries on every run, so a failure names its seed.
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

function randomLibrary(seed: number): Database {
  const rand = random(seed);
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)];
  const db = openDb(":memory:");
  const node = (type: string, title: string) =>
    (db.prepare("INSERT INTO nodes (type, title) VALUES (?, ?) RETURNING id").get(type, title) as { id: number }).id;
  const artists = Array.from({ length: 4 + Math.floor(rand() * 8) }, (_, i) => node("artist", `Artist ${i}`));
  const credits = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => node("credit", `Credit ${i}`));
  const releases = Array.from({ length: 3 + Math.floor(rand() * 8) }, (_, i) => node("release", `Release ${i}`));
  const root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/fake') RETURNING id").get() as { id: number }).id;

  const edges: [number, number, string][] = [];
  const recordings: number[] = [];
  for (let i = 0; i < 20 + Math.floor(rand() * 40); i++) {
    const recording = node("recording", `Track ${i}`);
    recordings.push(recording);
    db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
    // One in five is a recording a collapse left behind, with no file, and
    // one file in ten has gone missing.
    if (rand() < 0.8) {
      db.prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, missing_since)
         VALUES (?, ?, ?, datetime('now'), 0, ?)`,
      ).run(recording, root, `/fake/${recording}.flac`, rand() < 0.1 ? "2026-01-01 00:00:00" : null);
    }
    edges.push([recording, pick(releases), "appears_on"]);
    for (let p = 0; p < 1 + Math.floor(rand() * 3); p++) {
      edges.push([recording, rand() < 0.2 ? pick(credits) : pick(artists), "performed_by"]);
    }
    if (rand() < 0.2) edges.push([recording, pick(artists), "featured_artist"]);
    if (rand() < 0.1) edges.push([recording, pick(credits), "produced_by"]);
  }
  // Hand-drawn: an artist "appearing on" a record, and tracks "appearing on"
  // something that isn't one.
  if (rand() < 0.5) edges.push([pick(artists), pick(releases), "appears_on"]);
  if (rand() < 0.3) {
    const label = node("label", "A Label");
    for (let i = 0; i < 3; i++) edges.push([pick(recordings), rand() < 0.5 ? label : pick(artists), "appears_on"]);
  }
  // Edge ids out of credit order.
  for (let i = edges.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [edges[i], edges[j]] = [edges[j], edges[i]];
  }
  const insert = db.prepare("INSERT OR IGNORE INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')");
  for (const [from, to, type] of edges) insert.run(from, to, type);

  recomputeEntities(db);
  recomputeTracksLayout(db);
  return db;
}

describe("the Artists tab and the map's clusters (#302)", () => {
  it(`name the same artists with the same records, in ${LIBRARIES} random libraries`, async () => {
    const disagreements: string[] = [];
    for (let seed = 1; seed <= LIBRARIES; seed++) {
      const db = randomLibrary(seed);
      const app = Fastify();
      await app.register(nodesRoutes(db), { prefix: "/api/v1" });
      await app.register(libraryRoutes(db), { prefix: "/api/v1" });
      const get = async (url: string) => (await app.inject({ method: "GET", url: `/api/v1${url}` })).json();

      const nodes = (await get("/nodes?limit=20000")) as ClusterNode[];
      const edges = (await get("/edges")) as ClusterEdge[];
      const { releasesOf } = computeClusters(nodes, edges);
      const map = Object.fromEntries(
        nodes.filter((n) => n.type === "artist" && (releasesOf.get(n.id)?.length ?? 0) > 0).map((n) => [n.id, releasesOf.get(n.id)!.length]),
      );
      const { items } = (await get("/library/artists?limit=500")) as { items: { id: number; releases: number }[] };
      const tab = Object.fromEntries(items.map((a) => [a.id, a.releases]));

      if (JSON.stringify(Object.entries(map).sort()) !== JSON.stringify(Object.entries(tab).sort())) {
        disagreements.push(`seed ${seed}: map ${JSON.stringify(map)}, tab ${JSON.stringify(tab)}`);
      }
      await app.close();
      db.close();
    }
    expect(disagreements).toEqual([]);
  });
});
