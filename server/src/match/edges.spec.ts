import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { deriveLocalEdges, deriveRecordingEdges, findOrCreatePerson } from "./edges.js";
import { recordArtistCredit } from "./evidence.js";

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

function recordingOf(fileId: number): number {
  return (db.prepare("SELECT recording_node_id FROM files WHERE id = ?").get(fileId) as { recording_node_id: number })
    .recording_node_id;
}

function personEdges(nodeId: number, type: string): string[] {
  return (
    db
      .prepare(
        `SELECT n.title FROM edges e JOIN nodes n ON n.id = e.to_node
          WHERE e.from_node = ? AND e.type = ? ORDER BY e.id`,
      )
      .all(nodeId, type) as { title: string }[]
  ).map((r) => r.title);
}

function nodeNamed(type: string, title: string): number | undefined {
  return (db.prepare("SELECT id FROM nodes WHERE type = ? AND title = ?").get(type, title) as { id: number } | undefined)
    ?.id;
}

// Issue #273, cause 1: a line joined by "," or "&" splits when the file or
// MusicBrainz names its artists one by one, and stays whole otherwise.
describe("deriveLocalEdges — lines joined by comma or ampersand", () => {
  it("splits a performer line its ARTISTS tag lists as two artists", () => {
    const fileId = insertFile({
      artist: "Cage The Elephant, Alison Mosshart",
      artists: ["Cage The Elephant", "Alison Mosshart"],
    });
    deriveLocalEdges(db, fileId);

    expect(personEdges(recordingOf(fileId), "performed_by")).toEqual(["Cage The Elephant", "Alison Mosshart"]);
    expect(nodeNamed("artist", "Cage The Elephant, Alison Mosshart")).toBeUndefined();
  });

  it("splits a performer line on MusicBrainz's artist credit when the file has no ARTISTS tag", () => {
    const fileId = insertFile({ artist: "Cage The Elephant, Alison Mosshart" });
    recordArtistCredit(db, recordingOf(fileId), [
      { name: "Cage the Elephant", artist: "Cage the Elephant", joinphrase: " feat. " },
      { name: "Alison Mosshart", artist: "Alison Mosshart", joinphrase: "" },
    ]);
    deriveLocalEdges(db, fileId);

    // The tag's own spelling, not MusicBrainz's.
    expect(personEdges(recordingOf(fileId), "performed_by")).toEqual(["Cage The Elephant", "Alison Mosshart"]);
  });

  it("leaves a duo named with an ampersand whole", () => {
    const fileId = insertFile({ artist: "Simon & Garfunkel", artists: ["Simon & Garfunkel"] });
    recordArtistCredit(db, recordingOf(fileId), [{ name: "Simon & Garfunkel", artist: "Simon & Garfunkel", joinphrase: "" }]);
    // MusicBrainz credits each of them as a vocalist too. That isn't evidence
    // for the performer line.
    const paul = makeCredit("Paul Simon");
    const art = makeCredit("Art Garfunkel");
    for (const person of [paul, art]) {
      db.prepare("INSERT INTO edges (from_node, to_node, type, source, label) VALUES (?, ?, 'performed_credit', 'musicbrainz', 'vocals')").run(
        recordingOf(fileId),
        person,
      );
    }
    deriveLocalEdges(db, fileId);

    expect(personEdges(recordingOf(fileId), "performed_by")).toEqual(["Simon & Garfunkel"]);
  });

  it("leaves a comma line whole when nothing but the comma says it's two artists", () => {
    const fileId = insertFile({ artist: "Crosby, Stills & Nash" });
    deriveLocalEdges(db, fileId);

    expect(personEdges(recordingOf(fileId), "performed_by")).toEqual(["Crosby, Stills & Nash"]);
  });

  it("splits a producer line on the producers MusicBrainz credits one by one", () => {
    const fileId = insertFile({
      artist: "Fiona Apple",
      producer: ["Fiona Apple, Sebastian Steinberg, David Garza & Amy Aileen Wood"],
    });
    const recording = recordingOf(fileId);
    for (const name of ["Fiona Apple", "Amy Aileen Wood", "Sebastian Steinberg", "David Garza"]) {
      db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'produced_by', 'musicbrainz')").run(
        recording,
        findOrCreatePerson(db, "credit", name),
      );
    }
    deriveLocalEdges(db, fileId);

    expect(
      (
        db
          .prepare(
            `SELECT n.title FROM edges e JOIN nodes n ON n.id = e.to_node
              WHERE e.from_node = ? AND e.type = 'produced_by' AND e.source = 'local' ORDER BY e.id`,
          )
          .all(recording) as { title: string }[]
      ).map((r) => r.title),
    ).toEqual(["Fiona Apple", "Sebastian Steinberg", "David Garza", "Amy Aileen Wood"]);
    // Fiona Apple produced and performed it: one node, an artist.
    expect(db.prepare("SELECT type FROM nodes WHERE title = 'Fiona Apple'").all()).toEqual([{ type: "artist" }]);
  });
});

function makeCredit(title: string): number {
  return (db.prepare("INSERT INTO nodes (type, title) VALUES ('credit', ?) RETURNING id").get(title) as { id: number }).id;
}

// Issue #273, cause 2: one person, one node.
describe("findOrCreatePerson", () => {
  it("puts a producer credit on the artist node of the same name", () => {
    const fileId = insertFile({ artist: "Bob Dylan", producer: ["bob dylan"] });
    deriveLocalEdges(db, fileId);

    expect(db.prepare("SELECT type, title FROM nodes WHERE type IN ('artist', 'credit')").all()).toEqual([
      { type: "artist", title: "Bob Dylan" },
    ]);
    expect(edgesFrom(recordingOf(fileId)).map((e) => e.type)).toEqual(["performed_by", "produced_by"]);
  });

  it("turns a credit node into the artist when that person performs, keeping its id and favourite", () => {
    const credit = makeCredit("Alison Mosshart");
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(credit);

    expect(findOrCreatePerson(db, "artist", "Alison Mosshart")).toBe(credit);
    expect(db.prepare("SELECT type FROM nodes WHERE id = ?").get(credit)).toEqual({ type: "artist" });
    expect(db.prepare("SELECT node_id FROM favourites").all()).toEqual([{ node_id: credit }]);
  });

  it("still makes a credit node for someone who is only ever credited", () => {
    const id = findOrCreatePerson(db, "credit", "Bob Johnston");
    expect(db.prepare("SELECT type FROM nodes WHERE id = ?").get(id)).toEqual({ type: "credit" });
    expect(findOrCreatePerson(db, "credit", "BOB JOHNSTON")).toBe(id);
  });
});

// The upgrade path: a library scanned before #273 has the joined node, and
// the evidence arrives later (enrich/artistCredit.ts).
describe("deriveRecordingEdges — retiring a joined node", () => {
  function joinedLibrary() {
    const fileId = insertFile({ artist: "Cage The Elephant, Alison Mosshart" });
    deriveLocalEdges(db, fileId);
    const recording = recordingOf(fileId);
    const joined = nodeNamed("artist", "Cage The Elephant, Alison Mosshart")!;
    return { fileId, recording, joined };
  }

  function addEvidence(fileId: number): void {
    const tags = JSON.parse(
      (db.prepare("SELECT tags_raw FROM files WHERE id = ?").get(fileId) as { tags_raw: string }).tags_raw,
    ) as Record<string, unknown>;
    db.prepare("UPDATE files SET tags_raw = ? WHERE id = ?").run(
      JSON.stringify({ ...tags, artists: ["Cage The Elephant", "Alison Mosshart"] }),
      fileId,
    );
  }

  it("hands the joined node's favourite, connections and position to the line's first artist", () => {
    const { fileId, recording, joined } = joinedLibrary();
    const beck = findOrCreatePerson(db, "artist", "Beck");
    db.prepare("INSERT INTO favourites (node_id) VALUES (?)").run(joined);
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'personal', 'manual')").run(joined, beck);
    db.prepare(
      "INSERT INTO positions (node_id, granularity, seed_x, seed_y, user_x, user_y) VALUES (?, 'tracks', 1, 2, 3, 4)",
    ).run(joined);

    addEvidence(fileId);
    deriveRecordingEdges(db, recording);

    const cage = nodeNamed("artist", "Cage The Elephant")!;
    expect(db.prepare("SELECT id FROM nodes WHERE id = ?").get(joined)).toBeUndefined();
    expect(personEdges(recording, "performed_by")).toEqual(["Cage The Elephant", "Alison Mosshart"]);
    expect(db.prepare("SELECT node_id FROM favourites").all()).toEqual([{ node_id: cage }]);
    expect(db.prepare("SELECT from_node, to_node FROM edges WHERE source = 'manual'").all()).toEqual([
      { from_node: cage, to_node: beck },
    ]);
    expect(db.prepare("SELECT node_id, user_x, user_y FROM positions").all()).toEqual([
      { node_id: cage, user_x: 3, user_y: 4 },
    ]);
  });

  it("doesn't hand the artist what enrichment found under the joined name", () => {
    const { fileId, recording, joined } = joinedLibrary();
    db.prepare("INSERT INTO descriptions (node_id, body, source, found) VALUES (?, NULL, 'wikipedia', 0)").run(joined);
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'artist_image', 'joined-photo')").run(joined);
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'manual', 'chosen-by-user')").run(joined);
    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source) VALUES (?, 'artist_mbid', NULL, 'musicbrainz')",
    ).run(joined);
    db.prepare("INSERT INTO enrich_jobs (node_id, job_type, status) VALUES (?, 'artist_image_lookup', 'done')").run(joined);

    addEvidence(fileId);
    deriveRecordingEdges(db, recording);

    const cage = nodeNamed("artist", "Cage The Elephant")!;
    expect(db.prepare("SELECT COUNT(*) AS n FROM descriptions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT node_id, source FROM cover_art").all()).toEqual([{ node_id: cage, source: "manual" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM field_provenance").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM enrich_jobs").get()).toEqual({ n: 0 });
  });

  it("keeps the joined node while another recording still credits it without evidence", () => {
    const { fileId, recording, joined } = joinedLibrary();
    const other = insertFile({ artist: "Cage The Elephant, Alison Mosshart" });
    deriveLocalEdges(db, other);

    addEvidence(fileId);
    deriveRecordingEdges(db, recording);

    expect(personEdges(recording, "performed_by")).toEqual(["Cage The Elephant", "Alison Mosshart"]);
    expect(personEdges(recordingOf(other), "performed_by")).toEqual(["Cage The Elephant, Alison Mosshart"]);
    expect(db.prepare("SELECT id FROM nodes WHERE id = ?").get(joined)).toEqual({ id: joined });
  });

  it("leaves an artist alone when a tag edit, not a split, drops it", () => {
    const fileId = insertFile({ artist: "Foo" });
    deriveLocalEdges(db, fileId);
    const foo = nodeNamed("artist", "Foo")!;
    db.prepare("UPDATE files SET tags_raw = ? WHERE id = ?").run(JSON.stringify({ artist: "Bar" }), fileId);

    deriveLocalEdges(db, fileId);

    expect(db.prepare("SELECT id FROM nodes WHERE id = ?").get(foo)).toEqual({ id: foo });
  });
});

// Issue #281: recompute derives every file on its worker's connection while
// the request loop's can be deriving one too, so a file is derived whole or
// not at all, never half on top of the other's half.
describe("deriveLocalEdges — one transaction", () => {
  it("leaves the edges as they were when it fails part-way", () => {
    const fileId = insertFile({ artist: "The Beatles", album: "Abbey Road" });
    deriveLocalEdges(db, fileId);
    const recording = recordingOf(fileId);
    const before = edgesFrom(recording);
    expect(before.map((e) => e.type)).toEqual(["appears_on", "performed_by"]);

    db.exec(
      `CREATE TEMP TRIGGER fail_appears_on BEFORE INSERT ON edges WHEN NEW.type = 'appears_on'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() => deriveLocalEdges(db, fileId)).toThrow("boom");
    expect(edgesFrom(recording)).toEqual(before);
  });
});
