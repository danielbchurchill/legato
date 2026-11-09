import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { openDb } from "../db.js";
import { recomputeSimilarityFeatures } from "../similarity/similarity.js";
import type { Database } from "../sqlite.js";
import { similarityRoutes } from "./similarity.js";

function track(db: Database, title: string, artist: number): number {
  const id = (db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as { id: number }).id;
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(id);
  const root = (db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${id}`) as { id: number }).id;
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, genre)
     VALUES (?, ?, ?, datetime('now'), 0, '["rock"]')`,
  ).run(id, root, `/fake/${id}.flac`);
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(id, artist);
  return id;
}

describe("GET /nodes/:id/similar", () => {
  it("answers with the closest tracks, and leaves out one deleted since the vectors were read", async () => {
    const db = openDb(":memory:");
    const app = Fastify();
    await app.register(similarityRoutes(db), { prefix: "/api/v1" });
    const artist = (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'The Beatles') RETURNING id").get() as { id: number }).id;
    const anchor = track(db, "Come Together", artist);
    const gone = track(db, "Something", artist);
    const kept = track(db, "Get Back", artist);
    recomputeSimilarityFeatures(db);
    const similar = async () =>
      ((await app.inject({ method: "GET", url: `/api/v1/nodes/${anchor}/similar?limit=5` })).json() as { id: number; title: string }[]).map(
        (r) => [r.id, r.title],
      );

    expect(await similar()).toEqual([
      [gone, "Something"],
      [kept, "Get Back"],
    ]);

    // A hygiene merge, say: the node goes, and its vector with it, but the
    // copy in memory stays until the next recompute changes something.
    for (const sql of [
      "DELETE FROM files WHERE recording_node_id = ?",
      "DELETE FROM edges WHERE from_node = ?",
      "DELETE FROM recordings WHERE node_id = ?",
      "DELETE FROM nodes WHERE id = ?",
    ]) {
      db.prepare(sql).run(gone);
    }
    expect(db.prepare("SELECT 1 FROM node_similarity_features WHERE node_id = ?").get(gone)).toBeFalsy();
    expect(await similar()).toEqual([[kept, "Get Back"]]);

    const artistAnswer = await app.inject({ method: "GET", url: `/api/v1/nodes/${artist}/similar` });
    expect(artistAnswer.json()).toEqual([]);
  });
});
