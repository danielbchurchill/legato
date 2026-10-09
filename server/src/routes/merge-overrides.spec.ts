import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { openDb } from "../db.js";
import { libraryRevision } from "../libraryRevision.js";
import { mergeOverridesRoutes } from "./merge-overrides.js";

describe("POST /merge-overrides", () => {
  // #302: the file moves to another recording, which changes how many tracks
  // GET /stats counts, so the Library header has to fetch again.
  it("moves the file to the recording it's forced onto, and bumps the library revision", async () => {
    const db = openDb(":memory:");
    const app = Fastify();
    await app.register(mergeOverridesRoutes(db), { prefix: "/api/v1" });
    const root = (db.prepare("INSERT INTO library_roots (path) VALUES ('/fake') RETURNING id").get() as { id: number }).id;
    const recording = (title: string) => {
      const id = (db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as { id: number }).id;
      db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(id);
      return id;
    };
    const kept = recording("Song");
    const duplicate = recording("Song (copy)");
    const file = (
      db
        .prepare(
          `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw)
           VALUES (?, ?, '/fake/song.flac', datetime('now'), 0, '{}') RETURNING id`,
        )
        .get(duplicate, root) as { id: number }
    ).id;

    const before = libraryRevision();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/merge-overrides",
      payload: { fileId: file, forcedRecordingNodeId: kept },
    });

    expect(res.statusCode).toBe(200);
    expect(db.prepare("SELECT recording_node_id AS id FROM files WHERE id = ?").get(file)).toEqual({ id: kept });
    expect(libraryRevision()).toBe(before + 1);
  });
});
