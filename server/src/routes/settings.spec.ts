import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { subscribe } from "../ws.js";
import { settingsRoutes } from "./settings.js";

let db: Database;
let app: FastifyInstance;
let events: { event: string; payload: unknown }[];
let unsubscribe: () => void;

beforeEach(async () => {
  db = openDb(":memory:");
  app = Fastify();
  await app.register(settingsRoutes(db));
  events = [];
  unsubscribe = subscribe((message) => events.push(JSON.parse(message)));
});

afterEach(async () => {
  unsubscribe();
  await app.close();
});

const put = (url: string, payload: Record<string, string>) => app.inject({ method: "PUT", url, payload });

describe("settings", () => {
  it("saves a partial and answers with every setting", async () => {
    await put("/settings", { showTracks: "false" });
    const res = await put("/settings", { forceCenterStrength: "0.08" });
    expect(res.json()).toEqual({ showTracks: "false", forceCenterStrength: "0.08" });
    expect((await app.inject({ method: "GET", url: "/settings" })).json()).toEqual({ showTracks: "false", forceCenterStrength: "0.08" });
  });

  // #467: a phone moving a map option shows on a desktop open on the same
  // library, and the other way round.
  it("tells every connected client what a write changed, and which page wrote it", async () => {
    await put("/settings?from=k3x9a1", { forceCenterStrength: "0.08", "nodeSize:artist": "1.50" });
    expect(events).toEqual([
      { event: "settings:changed", payload: { changed: { forceCenterStrength: "0.08", "nodeSize:artist": "1.50" }, from: "k3x9a1" } },
    ]);
  });

  it("names no writer when the page didn't say, or said something that isn't an id", async () => {
    await put("/settings", { showTracks: "true" });
    await put(`/settings?from=${encodeURIComponent("<script>")}`, { showTracks: "false" });
    await put(`/settings?from=${"a".repeat(65)}`, { showTracks: "true" });
    expect(events.map((e) => e.payload)).toEqual([
      { changed: { showTracks: "true" } },
      { changed: { showTracks: "false" } },
      { changed: { showTracks: "true" } },
    ]);
  });

  it("says nothing for a write that changed nothing", async () => {
    await put("/settings?from=k3x9a1", {});
    expect(events).toEqual([]);
  });
});
