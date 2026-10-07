import Fastify from "fastify";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { getWorklist } from "../hygiene.js";
import { mocked } from "../testing.js";
import * as mbClient from "../enrich/mbClient.js";

mock.module("../enrich/mbClient.js", () => ({ lookupRecording: mock() }));

const { hygieneRoutes } = await import("./hygiene.js");

const MBID = "b1a9c0e9-d987-4042-ae91-78d6a3267d69";
const MERGED_INTO = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  mock.clearAllMocks();
});

function makeRecording(title: string, durationMs: number | null = null): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as { id: number };
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(node.id, durationMs);
  const root = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(`/fake/${node.id}`) as { id: number };
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, match_source)
     VALUES (?, ?, ?, datetime('now'), 0, 'unmatched')`,
  ).run(node.id, root.id, `/fake/${node.id}/track.flac`);
  db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, confidence, note) VALUES (?, 'mbid', NULL, 'musicbrainz', 0, 'no MusicBrainz match found')",
  ).run(node.id);
  return node.id;
}

async function inject(method: "GET" | "POST", url: string, payload?: object) {
  const app = Fastify();
  await app.register(hygieneRoutes(db), { prefix: "/api/v1" });
  return app.inject({ method, url: `/api/v1${url}`, payload });
}

// The flow the card was built for, which #272 must leave exactly as it was.
describe("ambiguous match candidates", () => {
  function addCandidates(nodeId: number): void {
    const insert = db.prepare(
      "INSERT INTO match_candidates (node_id, mbid, release_title, release_date, duration_ms, score) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run(nodeId, "mb-live", "Live at the BBC", "1994-11-30", 250000, 0.6);
    insert.run(nodeId, "mb-studio", "Abbey Road", "1969-09-26", 259000, 0.9);
  }

  it("lists the candidates best first, with each one's distance from the local duration", async () => {
    const nodeId = makeRecording("Come Together", 260000);
    addCandidates(nodeId);

    const res = await inject("GET", `/hygiene/match-candidates/${nodeId}`);

    expect(res.json()).toMatchObject([
      { mbid: "mb-studio", release_title: "Abbey Road", score: 0.9, duration_delta_ms: 1000 },
      { mbid: "mb-live", release_title: "Live at the BBC", score: 0.6, duration_delta_ms: 10000 },
    ]);
  });

  it("resolves to the chosen candidate through applyMatch and drops the rest", async () => {
    const nodeId = makeRecording("Come Together", 260000);
    addCandidates(nodeId);

    const res = await inject("POST", `/hygiene/match-candidates/${nodeId}/resolve`, { mbid: "mb-studio" });

    expect(res.statusCode).toBe(204);
    expect(db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId)).toEqual({ mbid: "mb-studio" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM match_candidates WHERE node_id = ?").get(nodeId)).toEqual({ n: 0 });
    expect(getWorklist(db, "enrichment_flag")).toEqual([]);
  });

  it("refuses an mbid that wasn't one of the candidates", async () => {
    const nodeId = makeRecording("Come Together", 260000);
    addCandidates(nodeId);

    const res = await inject("POST", `/hygiene/match-candidates/${nodeId}/resolve`, { mbid: "mb-other" });

    expect(res.statusCode).toBe(404);
    expect(db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId)).toEqual({ mbid: null });
  });
});

describe("POST /hygiene/manual-match/:nodeId (#272)", () => {
  it("matches a no-match recording to a pasted recording link", async () => {
    const nodeId = makeRecording("Unfindable");
    mocked(mbClient.lookupRecording).mockResolvedValue({ mbid: MBID, title: "Unfindable" });

    const res = await inject("POST", `/hygiene/manual-match/${nodeId}`, {
      reference: `https://musicbrainz.org/recording/${MBID}`,
    });

    expect(res.statusCode).toBe(204);
    expect(mbClient.lookupRecording).toHaveBeenCalledWith(MBID);
    expect(db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId)).toEqual({ mbid: MBID });
    expect(db.prepare("SELECT match_source, match_confidence FROM files WHERE recording_node_id = ?").get(nodeId)).toEqual({
      match_source: "mbid",
      match_confidence: 1,
    });
    expect(getWorklist(db, "enrichment_flag")).toEqual([]);
  });

  it("takes a bare MBID, and stores the MBID MusicBrainz answers with for a merged recording", async () => {
    const nodeId = makeRecording("Merged");
    mocked(mbClient.lookupRecording).mockResolvedValue({ mbid: MERGED_INTO, title: "Merged" });

    const res = await inject("POST", `/hygiene/manual-match/${nodeId}`, { reference: `  ${MBID.toUpperCase()} ` });

    expect(res.statusCode).toBe(204);
    expect(mbClient.lookupRecording).toHaveBeenCalledWith(MBID);
    expect(db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId)).toEqual({ mbid: MERGED_INTO });
  });

  it("turns a release link away with what to paste instead, without asking MusicBrainz", async () => {
    const nodeId = makeRecording("On An Album");

    const res = await inject("POST", `/hygiene/manual-match/${nodeId}`, { reference: `https://musicbrainz.org/release/${MBID}` });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("That's a release link. Open the track on that release and paste its recording link.");
    expect(mbClient.lookupRecording).not.toHaveBeenCalled();
    expect(db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId)).toEqual({ mbid: null });
  });

  it("rejects text that isn't a MusicBrainz link or ID", async () => {
    const nodeId = makeRecording("Unfindable");

    const res = await inject("POST", `/hygiene/manual-match/${nodeId}`, { reference: "Come Together by The Beatles" });

    expect(res.statusCode).toBe(400);
    expect(mbClient.lookupRecording).not.toHaveBeenCalled();
  });

  it("reports an MBID MusicBrainz doesn't know, and writes nothing", async () => {
    const nodeId = makeRecording("Unfindable");
    mocked(mbClient.lookupRecording).mockResolvedValue(null);

    const res = await inject("POST", `/hygiene/manual-match/${nodeId}`, { reference: MBID });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("MusicBrainz has no recording with that ID.");
    expect(getWorklist(db, "enrichment_flag")).toHaveLength(1);
  });

  it("says MusicBrainz couldn't be reached when the lookup fails, and writes nothing", async () => {
    const nodeId = makeRecording("Unfindable");
    mocked(mbClient.lookupRecording).mockRejectedValue(new Error("MusicBrainz recording lookup failed: 503 Service Unavailable"));

    const res = await inject("POST", `/hygiene/manual-match/${nodeId}`, { reference: MBID });

    expect(res.statusCode).toBe(502);
    expect(db.prepare("SELECT mbid FROM nodes WHERE id = ?").get(nodeId)).toEqual({ mbid: null });
  });

  it("refuses a node that isn't a recording", async () => {
    const artist = (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'Someone') RETURNING id").get() as { id: number }).id;

    const res = await inject("POST", `/hygiene/manual-match/${artist}`, { reference: MBID });

    expect(res.statusCode).toBe(404);
    expect(mbClient.lookupRecording).not.toHaveBeenCalled();
  });
});
