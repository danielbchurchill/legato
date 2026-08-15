import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { deriveLocalEdges } from "./edges.js";

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function insertFile(tags: Record<string, unknown>): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'x') RETURNING id").get() as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${node.id}`) as {
    id: number;
  };
  const file = db
    .prepare(
      `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, tags_raw)
       VALUES (?, ?, ?, datetime('now'), 0, ?) RETURNING id`,
    )
    .get(node.id, root.id, `/fake/${node.id}.flac`, JSON.stringify(tags)) as { id: number };
  return file.id;
}

function edgesFrom(nodeId: number): { type: string; other_id: number; other_type: string; other_title: string }[] {
  return db
    .prepare(
      `SELECT e.type, n.id AS other_id, n.type AS other_type, n.title AS other_title
       FROM edges e JOIN nodes n ON n.id = e.to_node
       WHERE e.from_node = ?
       ORDER BY e.type, n.title`,
    )
    .all(nodeId) as { type: string; other_id: number; other_type: string; other_title: string }[];
}

describe("deriveLocalEdges — widened credit/label edges", () => {
  it("derives a released_on edge to a label node", () => {
    const fileId = insertFile({ artist: "The Beatles", label: "Apple Records" });
    const { recording_node_id: nodeId } = db
      .prepare("SELECT recording_node_id FROM files WHERE id = ?")
      .get(fileId) as { recording_node_id: number };

    deriveLocalEdges(db, fileId);

    const edges = edgesFrom(nodeId);
    const labelEdge = edges.find((e) => e.type === "released_on");
    expect(labelEdge?.other_type).toBe("label");
    expect(labelEdge?.other_title).toBe("Apple Records");
  });

  it("derives produced_by/engineered_by edges to 'credit' nodes, one per name", () => {
    const fileId = insertFile({
      artist: "The Beatles",
      producer: ["George Martin"],
      engineer: ["Geoff Emerick", "Phil McDonald"],
    });
    const { recording_node_id: nodeId } = db
      .prepare("SELECT recording_node_id FROM files WHERE id = ?")
      .get(fileId) as { recording_node_id: number };

    deriveLocalEdges(db, fileId);

    const edges = edgesFrom(nodeId);
    expect(edges.filter((e) => e.type === "produced_by").map((e) => e.other_title)).toEqual(["George Martin"]);
    expect(edges.every((e) => e.type !== "produced_by" || e.other_type === "credit")).toBe(true);
    expect(edges.filter((e) => e.type === "engineered_by").map((e) => e.other_title)).toEqual([
      "Geoff Emerick",
      "Phil McDonald",
    ]);
  });

  it("derives featured_artist edges to 'artist' nodes, distinct from performed_by's node type", () => {
    const fileId = insertFile({ artist: "The Beatles", featuredArtists: ["Billy Preston"] });
    const { recording_node_id: nodeId } = db
      .prepare("SELECT recording_node_id FROM files WHERE id = ?")
      .get(fileId) as { recording_node_id: number };

    deriveLocalEdges(db, fileId);

    const edges = edgesFrom(nodeId);
    const featured = edges.find((e) => e.type === "featured_artist");
    expect(featured?.other_type).toBe("artist");
    expect(featured?.other_title).toBe("Billy Preston");
  });

  it("a producer credited on two different tracks collapses to one 'credit' node", () => {
    const fileId1 = insertFile({ artist: "The Beatles", producer: ["George Martin"] });
    const fileId2 = insertFile({ artist: "The Beatles", producer: ["George Martin"] });
    deriveLocalEdges(db, fileId1);
    deriveLocalEdges(db, fileId2);

    const creditNodes = db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'credit'").get() as { n: number };
    expect(creditNodes.n).toBe(1);
  });

  it("re-derives cleanly on a second call — no duplicate edges", () => {
    const fileId = insertFile({ artist: "The Beatles", label: "Apple Records", producer: ["George Martin"] });
    const { recording_node_id: nodeId } = db
      .prepare("SELECT recording_node_id FROM files WHERE id = ?")
      .get(fileId) as { recording_node_id: number };

    deriveLocalEdges(db, fileId);
    deriveLocalEdges(db, fileId);

    expect(edgesFrom(nodeId)).toHaveLength(3); // performed_by, released_on, produced_by
  });
});
