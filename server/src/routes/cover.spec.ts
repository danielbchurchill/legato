import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { mocked } from "../testing.js";
import * as mbClient from "../enrich/mbClient.js";
import * as store from "../cover/store.js";

// Issue #461. MusicBrainz is stubbed at its client (cover/candidates.spec.ts
// says why), the Cover Art Archive and Deezer at fetch, and the cover store,
// which shells out to ffmpeg, is a fake that hashes nothing.
mock.module("../enrich/mbClient.js", () => ({
  USER_AGENT: "Legato/test",
  searchReleaseGroup: mock(),
  browseReleaseGroupReleases: mock(),
}));
mock.module("../cover/store.js", () => ({
  storeCover: mock(),
  readCover: mock(),
}));

const { coverRoutes } = await import("./cover.js");
const { clearCandidateCaches } = await import("../cover/candidates.js");
const { subscribe } = await import("../ws.js");

const GROUP = "416bb5e5-c7d1-3977-8fd7-7c9daf6c2be6";
const CD = "02ac7ce7-4f21-4010-8210-e682085c58ab";
const HASH = "0123456789abcdef0123456789abcdef01234567";

let db: Database;
let app: FastifyInstance;
let events: { event: string; payload: { nodeId?: number; kind?: string; nodeIds?: number[] } }[];
let stopListening: () => void;
let answers: Map<string, { body: string; type?: string; status?: number }>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(async () => {
  db = openDb(":memory:");
  clearCandidateCaches();
  mocked(mbClient.browseReleaseGroupReleases).mockReset();
  mocked(mbClient.browseReleaseGroupReleases).mockResolvedValue([
    {
      mbid: CD,
      title: "Rumours",
      date: "1977",
      country: "US",
      status: "Official",
      disambiguation: null,
      art: { artwork: true, front: true, back: false, count: 1, darkened: false },
    },
  ]);
  mocked(store.storeCover).mockReset();
  mocked(store.storeCover).mockResolvedValue(HASH);

  answers = new Map();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const answer = answers.get(url);
    if (!answer) return new Response("not found", { status: 404 });
    return new Response(answer.body, { status: answer.status ?? 200, headers: { "Content-Type": answer.type ?? "image/jpeg" } });
  }) as typeof fetch);

  events = [];
  stopListening = subscribe((message) => events.push(JSON.parse(message)));

  app = Fastify();
  app.addContentTypeParser(/^image\/.*/, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  await app.register(coverRoutes(db), { prefix: "/api/v1" });
});

afterEach(async () => {
  stopListening();
  fetchSpy.mockRestore();
  await app.close();
});

function album(title: string): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('release', ?) RETURNING id").get(title) as { id: number };
  const artist = db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', 'Fleetwood Mac') RETURNING id").get() as { id: number };
  db.prepare("INSERT INTO albums (node_id, primary_artist_node_id) VALUES (?, ?)").run(node.id, artist.id);
  db.prepare(
    "INSERT INTO field_provenance (node_id, field, value, source, confidence) VALUES (?, 'release_group_mbid', ?, 'musicbrainz', 1)",
  ).run(node.id, GROUP);
  return node.id;
}

function lookupsOff(): void {
  db.prepare("INSERT INTO settings (key, value) VALUES ('enrichmentEnabled', 'false')").run();
}

function coverRows(nodeId: number): { source: string; hash: string; origin_path: string | null }[] {
  return db.prepare("SELECT source, hash, origin_path FROM cover_art WHERE node_id = ? ORDER BY source").all(nodeId) as {
    source: string;
    hash: string;
    origin_path: string | null;
  }[];
}

const coverEvents = () => events.filter((e) => e.event === "enrich:applied" && e.payload.kind === "cover").map((e) => e.payload.nodeId);

describe("GET /nodes/:id/cover/picker", () => {
  it("says the album can be looked up, and whether its cover is a manual choice", async () => {
    const id = album("Rumours");
    const before = await app.inject({ method: "GET", url: `/api/v1/nodes/${id}/cover/picker` });
    expect(before.json()).toEqual({
      nodeId: id,
      online: true,
      searchable: true,
      manual: false,
      title: "Rumours",
      artist: "Fleetwood Mac",
      nodeIds: [id, id + 1],
    });

    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'manual', ?)").run(id, HASH);
    const after = await app.inject({ method: "GET", url: `/api/v1/nodes/${id}/cover/picker` });
    expect(after.json().manual).toBe(true);
  });

  it("says when online lookups are off", async () => {
    lookupsOff();
    const id = album("Rumours");
    const res = await app.inject({ method: "GET", url: `/api/v1/nodes/${id}/cover/picker` });
    expect(res.json().online).toBe(false);
  });
});

describe("GET /nodes/:id/cover/candidates", () => {
  it("lists a source's candidates for an album", async () => {
    const id = album("Rumours");
    const res = await app.inject({ method: "GET", url: `/api/v1/nodes/${id}/cover/candidates?source=caa` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      source: "caa",
      match: { title: "Rumours", artist: "Fleetwood Mac" },
      candidates: [{ id: `caa:${CD}:front`, source: "caa", kind: "front", edition: "1977 · US" }],
      more: 0,
    });
  });

  it("looks nothing up with online lookups off", async () => {
    lookupsOff();
    const id = album("Rumours");
    for (const source of ["caa", "deezer"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/nodes/${id}/cover/candidates?source=${source}` });
      expect(res.statusCode).toBe(403);
    }
    expect(mbClient.browseReleaseGroupReleases).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a source it doesn't know, and a node that isn't an album", async () => {
    const id = album("Rumours");
    const itunes = await app.inject({ method: "GET", url: `/api/v1/nodes/${id}/cover/candidates?source=itunes` });
    expect(itunes.statusCode).toBe(400);
    const track = (db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'Dreams') RETURNING id").get() as { id: number }).id;
    const res = await app.inject({ method: "GET", url: `/api/v1/nodes/${track}/cover/candidates?source=caa` });
    expect(res.statusCode).toBe(400);
  });

  it("says which source didn't answer", async () => {
    const id = album("Rumours");
    mocked(mbClient.browseReleaseGroupReleases).mockRejectedValue(new Error("503"));
    const res = await app.inject({ method: "GET", url: `/api/v1/nodes/${id}/cover/candidates?source=caa` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("The Cover Art Archive didn't answer");
  });
});

describe("GET /cover-candidates/:candidate/thumb", () => {
  it("proxies the thumbnail from its source", async () => {
    answers.set(`https://coverartarchive.org/release/${CD}/front-250.jpg`, { body: "thumb bytes" });
    const res = await app.inject({ method: "GET", url: `/api/v1/cover-candidates/${encodeURIComponent(`caa:${CD}:front`)}/thumb` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.body).toBe("thumb bytes");
  });

  it("never fetches a URL a client sends", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/cover-candidates/${encodeURIComponent("http://169.254.169.254/latest")}/thumb`,
    });
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 404 for an image its source doesn't have, and fetches nothing with lookups off", async () => {
    const missing = await app.inject({ method: "GET", url: `/api/v1/cover-candidates/caa:${CD}:back/thumb` });
    expect(missing.statusCode).toBe(404);

    lookupsOff();
    fetchSpy.mockClear();
    const off = await app.inject({ method: "GET", url: `/api/v1/cover-candidates/caa:${CD}:front/thumb` });
    expect(off.statusCode).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("choosing and resetting a cover", () => {
  it("stores the chosen candidate's full image as the album's manual cover", async () => {
    const id = album("Rumours");
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'embedded', ?)").run(id, "e".repeat(40));
    answers.set("https://cdn-images.dzcdn.net/images/cover/9732751ce91d786dcf30069853697078/1000x1000-000000-80-0-0.jpg", {
      body: "full image",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/nodes/${id}/cover/candidate`,
      payload: { candidate: "deezer:9732751ce91d786dcf30069853697078" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ nodeId: id, source: "manual", hash: HASH });
    expect(mocked(store.storeCover).mock.calls[0][0].toString()).toBe("full image");
    // The automatic cover stays underneath, for "Use the automatic cover".
    expect(coverRows(id)).toEqual([
      { source: "embedded", hash: "e".repeat(40), origin_path: null },
      {
        source: "manual",
        hash: HASH,
        origin_path: "https://cdn-images.dzcdn.net/images/cover/9732751ce91d786dcf30069853697078/1000x1000-000000-80-0-0.jpg",
      },
    ]);
    expect(coverEvents()).toEqual([id]);
  });

  it("removes the choice, leaving the automatic cover", async () => {
    const id = album("Rumours");
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'embedded', ?)").run(id, "e".repeat(40));
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'manual', ?)").run(id, HASH);

    const res = await app.inject({ method: "DELETE", url: `/api/v1/nodes/${id}/cover` });
    expect(res.statusCode).toBe(204);
    expect(coverRows(id).map((r) => r.source)).toEqual(["embedded"]);
    expect(coverEvents()).toEqual([id]);
  });

  it("names every node showing the cover: the album, its tracks and the artist borrowing it", async () => {
    const id = album("Rumours");
    const artist = id + 1;
    const track = (db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'Dreams') RETURNING id").get() as { id: number }).id;
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')").run(track, id);
    db.prepare("INSERT INTO cover_art (node_id, source, hash) VALUES (?, 'manual', ?)").run(id, HASH);
    await app.inject({ method: "DELETE", url: `/api/v1/nodes/${id}/cover` });
    expect(events.find((e) => e.payload.kind === "cover")?.payload.nodeIds?.sort((a, b) => a - b)).toEqual([id, artist, track]);
  });

  it("tells open views about an upload too", async () => {
    const id = album("Rumours");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/nodes/${id}/cover`,
      headers: { "content-type": "image/png" },
      payload: Buffer.from("png bytes"),
    });
    expect(res.statusCode).toBe(201);
    expect(coverRows(id).map((r) => r.source)).toEqual(["manual"]);
    expect(coverEvents()).toEqual([id]);
  });

  it("refuses a candidate with lookups off, and one that isn't an image", async () => {
    const id = album("Rumours");
    answers.set(`https://coverartarchive.org/release/${CD}/front-1200.jpg`, { body: "<html>", type: "text/html" });
    const notImage = await app.inject({ method: "POST", url: `/api/v1/nodes/${id}/cover/candidate`, payload: { candidate: `caa:${CD}:front` } });
    expect(notImage.statusCode).toBe(502);

    lookupsOff();
    const off = await app.inject({ method: "POST", url: `/api/v1/nodes/${id}/cover/candidate`, payload: { candidate: `caa:${CD}:front` } });
    expect(off.statusCode).toBe(403);
    expect(coverRows(id)).toEqual([]);
    expect(coverEvents()).toEqual([]);
  });
});
