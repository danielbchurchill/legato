import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { deriveLocalEdges } from "./edges.js";

let db: Database;

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

describe("deriveLocalEdges — multi-artist credits", () => {
  function performersOf(tags: Record<string, unknown>): string[] {
    const fileId = insertFile(tags);
    const { recording_node_id: nodeId } = db
      .prepare("SELECT recording_node_id FROM files WHERE id = ?")
      .get(fileId) as { recording_node_id: number };
    deriveLocalEdges(db, fileId);
    // Edge id order, not title order — credit order is the contract.
    return (
      db
        .prepare(
          `SELECT n.title FROM edges e JOIN nodes n ON n.id = e.to_node
           WHERE e.from_node = ? AND e.type = 'performed_by' ORDER BY e.id`,
        )
        .all(nodeId) as { title: string }[]
    ).map((r) => r.title);
  }

  it("gives every artist in a semicolon credit its own node", () => {
    expect(performersOf({ artist: "JPEGMAFIA; Danny Brown" })).toEqual(["JPEGMAFIA", "Danny Brown"]);
  });

  it("reuses one node for an artist credited across different collaborations", () => {
    performersOf({ artist: "Pussy Riot; Big Freedia" });
    performersOf({ artist: "Pussy Riot; salem ilese" });
    const pussyRiot = db.prepare("SELECT id FROM nodes WHERE type = 'artist' AND title = 'Pussy Riot'").all();
    expect(pussyRiot).toHaveLength(1);
    // Three artists total, not four — no combined "Pussy Riot; X" node.
    expect(db.prepare("SELECT id FROM nodes WHERE type = 'artist'").all()).toHaveLength(3);
  });

  it("keeps a band whose name contains 'and' as a single node", () => {
    expect(performersOf({ artist: "Peter Bjorn and John" })).toEqual(["Peter Bjorn and John"]);
  });

  it("keeps an ensemble whole and does not mint nodes from its ARTISTS breakdown", () => {
    const performers = performersOf({
      artist: "George Martin and His Orchestra",
      featuredArtists: ["George Martin", "His Orchestra"],
    });
    expect(performers).toEqual(["George Martin and His Orchestra"]);
    const artists = db.prepare("SELECT title FROM nodes WHERE type = 'artist'").all() as { title: string }[];
    expect(artists.map((a) => a.title)).toEqual(["George Martin and His Orchestra"]);
  });

  it("derives no performed_by edge at all when the credit is missing", () => {
    expect(performersOf({ album: "Untitled" })).toEqual([]);
  });
});

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

  it("derives a released_in edge from releaseDate's leading year (M-7)", () => {
    const fileId = insertFile({ artist: "The Beatles", releaseDate: "1969-09-26" });
    const { recording_node_id: nodeId } = db
      .prepare("SELECT recording_node_id FROM files WHERE id = ?")
      .get(fileId) as { recording_node_id: number };

    deriveLocalEdges(db, fileId);

    const yearEdge = edgesFrom(nodeId).find((e) => e.type === "released_in");
    expect(yearEdge?.other_type).toBe("year");
    expect(yearEdge?.other_title).toBe("1969");
  });

  it("a bare 4-digit releaseDate still derives a year edge", () => {
    const fileId = insertFile({ artist: "The Beatles", releaseDate: "1969" });
    const { recording_node_id: nodeId } = db
      .prepare("SELECT recording_node_id FROM files WHERE id = ?")
      .get(fileId) as { recording_node_id: number };

    deriveLocalEdges(db, fileId);

    expect(edgesFrom(nodeId).find((e) => e.type === "released_in")?.other_title).toBe("1969");
  });

  it("no released_in edge when releaseDate is absent", () => {
    const fileId = insertFile({ artist: "The Beatles" });
    const { recording_node_id: nodeId } = db
      .prepare("SELECT recording_node_id FROM files WHERE id = ?")
      .get(fileId) as { recording_node_id: number };

    deriveLocalEdges(db, fileId);

    expect(edgesFrom(nodeId).find((e) => e.type === "released_in")).toBeUndefined();
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
