import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { recompute } from "../recompute.js";
import { applyCredits } from "../enrich/credits.js";
import { recordArtistCredit } from "./evidence.js";
import { artistsByKeyQuery } from "./artistLookup.js";
import { backfillLocalEdges } from "./backfill-edges.js";
import { deriveLocalEdges } from "./edges.js";
import { LOCAL_EDGE_RULES_HASH } from "./localEdgeRules.js";
import { deriveChangedLocalEdges, localEdgeRulesChanged } from "./localEdgesQueue.js";

// Issue #323: a recompute derives the local edges of the files whose inputs
// changed, not of every file. Most of these check the result against what
// deriving every file gives, which is what every recompute did before.

let db: Database;
let rootId: number;

beforeEach(() => {
  db = openDb(":memory:");
  rootId = (db.prepare("INSERT INTO library_roots (path) VALUES ('/music') RETURNING id").get() as { id: number }).id;
});

type Added = { fileId: number; recording: number };

function addFile(filePath: string, tags: Record<string, unknown>): Added {
  const recording = (db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(filePath) as { id: number })
    .id;
  db.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(recording);
  const fileId = (
    db
      .prepare(
        `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, match_source, track_no, tags_raw)
         VALUES (?, ?, ?, datetime('now'), 0, 'mbid', ?, ?) RETURNING id`,
      )
      .get(recording, rootId, filePath, (tags.trackNo as number | undefined) ?? null, JSON.stringify(tags)) as { id: number }
  ).id;
  return { fileId, recording };
}

function retag(fileId: number, tags: Record<string, unknown>): void {
  db.prepare("UPDATE files SET tags_raw = ?, track_no = ? WHERE id = ?").run(
    JSON.stringify(tags),
    (tags.trackNo as number | undefined) ?? null,
    fileId,
  );
}

// Every local edge, by node ids: deriving again can't make a different
// graph without making or picking a different node.
function localEdges(): string[] {
  return (
    db.prepare("SELECT from_node, to_node, type FROM edges WHERE source = 'local' ORDER BY from_node, type, to_node").all() as {
      from_node: number;
      to_node: number;
      type: string;
    }[]
  ).map((e) => `${e.from_node} ${e.type} ${e.to_node}`);
}

// What deriving every file again would change: nothing, when the queue
// derived every file it had to.
function expectSameAsDerivingEveryFile(): void {
  const derived = localEdges();
  backfillLocalEdges(db);
  expect(localEdges()).toEqual(derived);
}

function edgeIdsOf(recording: number): number[] {
  return (db.prepare("SELECT id FROM edges WHERE from_node = ? AND source = 'local' ORDER BY id").all(recording) as { id: number }[]).map(
    (r) => r.id,
  );
}

function linked(recording: number, type: string): string[] {
  return (
    db
      .prepare(
        `SELECT n.title FROM edges e JOIN nodes n ON n.id = e.to_node
          WHERE e.from_node = ? AND e.type = ? AND e.source = 'local' ORDER BY e.id`,
      )
      .all(recording, type) as { title: string }[]
  ).map((r) => r.title);
}

function albumOf(recording: number): number {
  return (db.prepare("SELECT to_node FROM edges WHERE from_node = ? AND type = 'appears_on'").get(recording) as { to_node: number })
    .to_node;
}

function pendingPaths(): string[] {
  return (db.prepare("SELECT file_path FROM local_edges_pending ORDER BY id").all() as { file_path: string }[]).map((r) => r.file_path);
}

function changes(): number {
  return (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

describe("a recompute's local edges (#323)", () => {
  it("derives nothing, and writes nothing, when nothing has changed since the last run", () => {
    addFile("/music/A/1.flac", { artist: "Pearl", album: "A", trackNo: 1 });
    recompute(db);
    // A re-scan of an unchanged file only stamps it as seen.
    db.prepare("UPDATE files SET last_seen_at = datetime('now', '+1 minute')").run();
    expect(pendingPaths()).toEqual([]);

    const before = changes();
    expect(deriveChangedLocalEdges(db)).toEqual({ files: 0, everyFile: false });
    expect(changes()).toBe(before);
  });

  it("derives a new file's album folder and leaves every other folder's edges as they were", () => {
    const a = [1, 2, 3].map((n) => addFile(`/music/A/${n}.flac`, { artist: "Pearl", album: "A", trackNo: n }));
    const b = [1, 2, 3].map((n) => addFile(`/music/B/${n}.flac`, { artist: "Quartz", album: "B", trackNo: n }));
    recompute(db);
    const bEdges = b.map((f) => edgeIdsOf(f.recording));
    const aEdges = a.map((f) => edgeIdsOf(f.recording));

    addFile("/music/A/4.flac", { artist: "Pearl", album: "A", trackNo: 4 });
    expect(deriveChangedLocalEdges(db)).toEqual({ files: 4, everyFile: false });

    expect(b.map((f) => edgeIdsOf(f.recording))).toEqual(bEdges);
    expect(a.map((f) => edgeIdsOf(f.recording))).not.toEqual(aEdges);
    expect(pendingPaths()).toEqual([]);
    expectSameAsDerivingEveryFile();
  });

  it("moves the files beside a new one when it splits their folder into two albums", () => {
    const pearl = [1, 2].map((n) => addFile(`/music/Hits/${n}.flac`, { artist: "Pearl", album: "Greatest Hits", trackNo: n }));
    const quartz = addFile("/music/Hits/3.flac", { artist: "Quartz", album: "Greatest Hits", trackNo: 3 });
    recompute(db);
    // A compilation: one album for the folder.
    expect(new Set([...pearl, quartz].map((f) => albumOf(f.recording))).size).toBe(1);

    // Quartz's own track 1 beside Pearl's: two artists' albums of one title.
    addFile("/music/Hits/4.flac", { artist: "Quartz", album: "Greatest Hits", trackNo: 1 });
    recompute(db);

    expect(albumOf(pearl[0]!.recording)).toBe(albumOf(pearl[1]!.recording));
    expect(albumOf(quartz.recording)).not.toBe(albumOf(pearl[0]!.recording));
    expectSameAsDerivingEveryFile();
  });

  it("derives the folder a file left when it goes missing", () => {
    const pearl = [1, 2].map((n) => addFile(`/music/Hits/${n}.flac`, { artist: "Pearl", album: "Greatest Hits", trackNo: n }));
    const quartz = addFile("/music/Hits/3.flac", { artist: "Quartz", album: "Greatest Hits", trackNo: 1 });
    recompute(db);
    expect(albumOf(pearl[1]!.recording)).not.toBe(albumOf(quartz.recording));

    // Without Pearl's track 1, nothing collides: one compilation again.
    db.prepare("UPDATE files SET missing_since = datetime('now') WHERE id = ?").run(pearl[0]!.fileId);
    recompute(db);

    expect(albumOf(quartz.recording)).toBe(albumOf(pearl[1]!.recording));
    expectSameAsDerivingEveryFile();
  });

  it("derives both folders of a moved file: the one it left and the one it joined", () => {
    const pearl = [1, 2].map((n) => addFile(`/music/Hits/${n}.flac`, { artist: "Pearl", album: "Greatest Hits", trackNo: n }));
    const quartz = addFile("/music/Hits/3.flac", { artist: "Quartz", album: "Greatest Hits", trackNo: 1 });
    const other = [1, 2].map((n) => addFile(`/music/More/${n}.flac`, { artist: "Pearl", album: "More", trackNo: n }));
    recompute(db);

    // What a scan sees: the old path gone, a new one found.
    db.prepare("UPDATE files SET missing_since = datetime('now') WHERE id = ?").run(quartz.fileId);
    addFile("/music/More/3.flac", { artist: "Quartz", album: "More", trackNo: 3 });
    recompute(db);
    expectSameAsDerivingEveryFile();
    expect(new Set(other.map((f) => albumOf(f.recording))).size).toBe(1);

    // And a row whose path changed in place: Quartz's "Greatest Hits" track 1
    // back beside Pearl's, which splits the folder into two artists' albums.
    db.prepare("UPDATE files SET file_path = '/music/Hits/9.flac', tags_raw = ? WHERE id = ?").run(
      JSON.stringify({ artist: "Quartz", album: "Greatest Hits", trackNo: 1 }),
      other[0]!.fileId,
    );
    expect(pendingPaths()).toEqual(["/music/Hits/9.flac", "/music/More/1.flac"]);
    recompute(db);
    expect(albumOf(pearl[0]!.recording)).toBe(albumOf(pearl[1]!.recording));
    expect(albumOf(other[0]!.recording)).not.toBe(albumOf(pearl[0]!.recording));
    expectSameAsDerivingEveryFile();
  });

  it("derives the folder of a file whose row is deleted, as removing a library folder does", () => {
    const pearl = [1, 2].map((n) => addFile(`/music/Hits/${n}.flac`, { artist: "Pearl", album: "Greatest Hits", trackNo: n }));
    const quartz = addFile("/music/Hits/3.flac", { artist: "Quartz", album: "Greatest Hits", trackNo: 1 });
    recompute(db);

    db.prepare("DELETE FROM files WHERE id = ?").run(pearl[0]!.fileId);
    recompute(db);

    expect(albumOf(quartz.recording)).toBe(albumOf(pearl[1]!.recording));
    expectSameAsDerivingEveryFile();
  });

  it("queues an album's files when a key it's found by is taken back", () => {
    const files = [1, 2].map((n) => addFile(`/music/A/${n}.flac`, { artist: "Pearl", album: "A", trackNo: n }));
    addFile("/music/B/1.flac", { artist: "Quartz", album: "B" });
    recompute(db);

    db.prepare("DELETE FROM release_keys WHERE node_id = ? AND key LIKE '[\"artist\",%'").run(albumOf(files[0]!.recording));

    expect(pendingPaths()).toEqual(["/music/A/1.flac", "/music/A/2.flac"]);
    recompute(db);
    expectSameAsDerivingEveryFile();
  });

  it("moves a file's neighbours when its own tags change", () => {
    const pearl = [1, 2].map((n) => addFile(`/music/Hits/${n}.flac`, { artist: "Pearl", album: "Greatest Hits", trackNo: n }));
    const quartz = [3, 4].map((n) => addFile(`/music/Hits/${n}.flac`, { artist: "Quartz", album: "Greatest Hits", trackNo: n }));
    recompute(db);
    const together = albumOf(pearl[0]!.recording);

    retag(quartz[0]!.fileId, { artist: "Quartz", album: "Greatest Hits", trackNo: 1 });
    recompute(db);

    expect(albumOf(quartz[1]!.recording)).toBe(albumOf(quartz[0]!.recording));
    expect(albumOf(quartz[1]!.recording)).not.toBe(albumOf(pearl[0]!.recording));
    expect([albumOf(pearl[0]!.recording), albumOf(quartz[1]!.recording)]).toContain(together);
    expectSameAsDerivingEveryFile();
  });

  it("splits a producer line once MusicBrainz's producer relations arrive after the scan", () => {
    const { recording } = addFile("/music/Fetch/1.flac", {
      artist: "Fiona Apple",
      album: "Fetch the Bolt Cutters",
      producer: ["Fiona Apple, Sebastian Steinberg, David Garza & Amy Aileen Wood"],
    });
    recompute(db);
    expect(linked(recording, "produced_by")).toEqual(["Fiona Apple, Sebastian Steinberg, David Garza & Amy Aileen Wood"]);

    const producer = (artistName: string) => ({ type: "producer", artistName, attributes: [] });
    applyCredits(db, recording, ["Fiona Apple", "Amy Aileen Wood", "Sebastian Steinberg", "David Garza"].map(producer));
    recompute(db);

    expect(linked(recording, "produced_by")).toEqual(["Fiona Apple", "Sebastian Steinberg", "David Garza", "Amy Aileen Wood"]);
    expectSameAsDerivingEveryFile();
  });

  it("splits a performer line once MusicBrainz's artist credit arrives after the scan", () => {
    const { recording } = addFile("/music/Ain't/1.flac", { artist: "Cage The Elephant, Alison Mosshart", album: "Social Cues" });
    recompute(db);
    expect(linked(recording, "performed_by")).toEqual(["Cage The Elephant, Alison Mosshart"]);

    recordArtistCredit(db, recording, [
      { name: "Cage The Elephant", artist: "Cage The Elephant", joinphrase: ", " },
      { name: "Alison Mosshart", artist: "Alison Mosshart", joinphrase: "" },
    ]);
    recompute(db);

    expect(linked(recording, "performed_by")).toEqual(["Cage The Elephant", "Alison Mosshart"]);
    expectSameAsDerivingEveryFile();
  });

  it("moves a credit onto an artist node of its name that appears later, as deriving every file does", () => {
    const produced = addFile("/music/U2/1.flac", { artist: "U2", album: "Boy", producer: ["Edge"] });
    recompute(db);
    expect(db.prepare("SELECT type FROM nodes WHERE title = 'Edge'").get()).toEqual({ type: "credit" });

    // A scan derives a file of its own as it reads it (scanner.ts's collapse stage).
    const solo = addFile("/music/Edge/1.flac", { artist: "The Edge", album: "Captive" });
    deriveLocalEdges(db, solo.fileId);
    expect(pendingPaths()).toContain("/music/U2/1.flac");
    recompute(db);

    expect(linked(produced.recording, "produced_by")).toEqual(["The Edge"]);
    expectSameAsDerivingEveryFile();
  });

  it("moves a file onto the node of its name that gains the MusicBrainz id its tag names", () => {
    const tagged = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id");
    tagged.get("Wilburys");
    const the = (tagged.get("The Wilburys") as { id: number }).id;
    const { recording } = addFile("/music/W/1.flac", { artist: "Wilburys", album: "Vol. 1", mbArtistId: "mb-wilburys" });
    recompute(db);
    expect(linked(recording, "performed_by")).toEqual(["Wilburys"]);

    db.prepare(
      "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'artist_mbid', 'mb-wilburys', 'musicbrainz', 1)",
    ).run(the);
    recompute(db);

    expect(linked(recording, "performed_by")).toEqual(["The Wilburys"]);
    expectSameAsDerivingEveryFile();
  });

  it("queues a name's files when another node of it appears, by artistLookup.ts's key and only then", () => {
    const cases: [string, string][] = [
      ["Beatles", "The Beatles"],
      ["The Beatles", "Beatles"],
      ["beatles ", "THE BEATLES"],
      ["The  Beatles", "Beatles"],
      ["Theodore", "odore"],
      ["The", "the"],
      ["Thee Oh Sees", "Oh Sees"],
    ];
    for (const [existing, added] of cases) {
      db = openDb(":memory:");
      rootId = (db.prepare("INSERT INTO library_roots (path) VALUES ('/music') RETURNING id").get() as { id: number }).id;
      const credit = (db.prepare("INSERT INTO nodes (type, title) VALUES ('credit', ?) RETURNING id").get(existing) as { id: number }).id;
      const { recording } = addFile("/music/A/1.flac", {});
      db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'produced_by', 'local')").run(recording, credit);
      db.exec("DELETE FROM local_edges_pending");

      db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?)").run(added);

      // The names findArtistByName would look `added` up by.
      const { params } = artistsByKeyQuery(added);
      const lowered = (db.prepare("SELECT lower(trim(?)) AS l").get(existing) as { l: string }).l;
      expect({ existing, added, queued: pendingPaths().length > 0 }).toEqual({ existing, added, queued: params.includes(lowered) });
    }
  });

  it("derives every file when the rules change, and stores them only once every file has committed", () => {
    const files = [1, 2, 3, 4].map((n) => addFile(`/music/${n}/1.flac`, { artist: `Artist ${n}`, album: `Album ${n}` }));
    recompute(db);
    expect(localEdgeRulesChanged(db)).toBe(false);
    db.prepare("UPDATE local_edges_rules SET hash = 'an older build' WHERE id = 1").run();
    db.prepare("DELETE FROM edges WHERE from_node = ?").run(files[0]!.recording);
    expect(localEdgeRulesChanged(db)).toBe(true);

    // The run stops partway: the third file's edges can't be written.
    db.exec(`CREATE TEMP TRIGGER stop BEFORE INSERT ON edges WHEN NEW.from_node = ${files[2]!.recording}
             BEGIN SELECT RAISE(ABORT, 'stopped'); END`);
    expect(() => deriveChangedLocalEdges(db)).toThrow("stopped");
    expect(localEdgeRulesChanged(db)).toBe(true);

    db.exec("DROP TRIGGER stop");
    expect(deriveChangedLocalEdges(db)).toEqual({ files: 4, everyFile: true });
    expect(db.prepare("SELECT hash FROM local_edges_rules").get()).toEqual({ hash: LOCAL_EDGE_RULES_HASH });
    expect(linked(files[0]!.recording, "performed_by")).toEqual(["Artist 1"]);
    expect(deriveChangedLocalEdges(db)).toEqual({ files: 0, everyFile: false });
  });

  it("keeps the queue when a run stops partway, and a path queued again while it runs for the next one", () => {
    const first = addFile("/music/A/1.flac", { artist: "Pearl", album: "A" });
    const second = addFile("/music/B/1.flac", { artist: "Quartz", album: "B" });
    recompute(db);

    retag(first.fileId, { artist: "Pearl", album: "A", label: "One" });
    retag(second.fileId, { artist: "Quartz", album: "B", label: "One" });
    db.exec(`CREATE TEMP TRIGGER stop BEFORE INSERT ON edges WHEN NEW.from_node = ${second.recording}
             BEGIN SELECT RAISE(ABORT, 'stopped'); END`);
    expect(() => deriveChangedLocalEdges(db)).toThrow("stopped");
    expect(pendingPaths()).toEqual(["/music/A/1.flac", "/music/B/1.flac"]);
    db.exec("DROP TRIGGER stop");

    // Someone retags the second file while the run derives the first.
    db.exec(`CREATE TEMP TRIGGER meanwhile AFTER INSERT ON edges WHEN NEW.from_node = ${first.recording} AND NEW.type = 'performed_by'
             BEGIN UPDATE files SET tags_raw = json_set(tags_raw, '$.label', 'Two') WHERE id = ${second.fileId}; END`);
    expect(deriveChangedLocalEdges(db)).toEqual({ files: 2, everyFile: false });
    db.exec("DROP TRIGGER meanwhile");

    expect(pendingPaths()).toEqual(["/music/B/1.flac"]);
    expect(linked(second.recording, "released_on")).toEqual(["Two"]);
  });

  it("derives every file on the first run after the migration, which stores no rules", () => {
    const files = [1, 2].map((n) => addFile(`/music/${n}/1.flac`, { artist: `Artist ${n}` }));
    // What the migration leaves on a library that already has its edges.
    db.exec("DELETE FROM local_edges_pending");
    db.prepare("UPDATE local_edges_rules SET hash = NULL").run();

    expect(localEdgeRulesChanged(db)).toBe(true);
    expect(deriveChangedLocalEdges(db)).toEqual({ files: 2, everyFile: true });
    expect(files.map((f) => linked(f.recording, "performed_by"))).toEqual([["Artist 1"], ["Artist 2"]]);
  });
});
