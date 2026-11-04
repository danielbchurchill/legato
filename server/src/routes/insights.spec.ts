import { beforeEach, describe, expect, it } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { libraryChanged } from "../libraryRevision.js";
import { recomputeInsights } from "../insights/recompute.js";
import { wilburysLibrary } from "../insights/testLibrary.js";
import { insightsRoutes } from "./insights.js";

let db: Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDb(":memory:");
  libraryChanged();
  app = Fastify();
  await app.register(insightsRoutes(db), { prefix: "/api/v1" });
});

const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url: `/api/v1${url}` });
  return { status: res.statusCode, body: res.json() };
};

describe("GET /insights", () => {
  it("says only that nothing is scanned yet, in a new library", async () => {
    expect(await get("/insights")).toEqual({ status: 200, body: { state: "empty" } });
  });

  it("is pending until a recompute has worked out the connections, with the listening cards already there", async () => {
    const { lib, albums } = wilburysLibrary(db);
    lib.play(albums.pinkMoon.tracks[0]!, 2);
    const { body } = await get("/insights");
    expect(body.state).toBe("pending");
    expect(body.mostPlayed.tracks[0]).toMatchObject({ node: { title: "Pink Moon 1" }, plays: 2 });
    // Band membership is read live, so band families can already show.
    expect(body.bandFamilies.length).toBe(1);
    expect(body.sharedLabels).toEqual([]);
  });

  it("answers every card once the connections are in", async () => {
    wilburysLibrary(db);
    recomputeInsights(db);
    libraryChanged();
    const { status, body } = await get("/insights");
    expect(status).toBe(200);
    expect(body.state).toBe("ready");
    expect(body.bridges[0].person.title).toBe("Jeff Lynne");
    expect(body.sharedPeople.length).toBe(3);
    expect(body.sharedLabels[0].label.title).toBe("Columbia");
    expect(body.mostConnected[0].artist.title).toBe("Traveling Wilburys");
    expect(body.islands.total).toBe(2);
    expect(body.recordedTogether.length).toBe(1);
    expect(body.soundsAlike.length).toBe(1);
    expect(body.pathSuggestion).not.toBeNull();
    expect(body.web).toEqual({ artists: 8, connected: 6, largest: 6, groups: 1 });
    expect(body.waiting.total).toBe(11);
    expect(body.shape.decades.map((d: { decade: number }) => d.decade)).toEqual([1960, 1970, 1980, 1990]);
    expect(body.shape.labels[0]).toMatchObject({ label: { title: "Columbia" }, albums: 4 });
    expect(body.careers[0].artist.title).toBe("Bob Dylan");
  });
});

describe("GET /insights/path", () => {
  it("names each step between two artists", async () => {
    const { id } = wilburysLibrary(db);
    recomputeInsights(db);
    libraryChanged();
    const { body } = await get(`/insights/path?from=${id("Tom Petty")}&to=${id("The Beatles")}`);
    expect(body.path.nodes.map((n: { title: string }) => n.title)).toEqual([
      "Tom Petty",
      "Traveling Wilburys",
      "George Harrison",
      "The Beatles",
    ]);
    expect(body.path.focus).toEqual(expect.arrayContaining([id("Tom Petty"), id("The Beatles")]));
  });

  it("is null for two artists nothing joins, or one that isn't yours", async () => {
    const { id } = wilburysLibrary(db);
    recomputeInsights(db);
    libraryChanged();
    expect((await get(`/insights/path?from=${id("Nick Drake")}&to=${id("Bob Dylan")}`)).body).toEqual({ path: null });
    expect((await get(`/insights/path?from=${id("Roy Orbison")}&to=${id("Bob Dylan")}`)).body).toEqual({ path: null });
  });

  it("turns away ids that aren't numbers", async () => {
    expect((await get("/insights/path?from=abc&to=2")).status).toBe(400);
  });
});

describe("GET /insights/artists", () => {
  it("lists your artists by name, filtered by q", async () => {
    wilburysLibrary(db);
    libraryChanged();
    const { body } = await get("/insights/artists?q=george");
    expect(body).toEqual([{ id: expect.any(Number), title: "George Harrison", type: "artist" }]);
    expect((await get("/insights/artists?limit=100")).body.length).toBe(8);
  });
});
