import { beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { TestLibrary } from "./insights/testLibrary.js";
import { listening } from "./insights/listening.js";
import { countLibraryRootContents } from "./library-roots.js";
import { dbInspectorSnapshot } from "./routes/db-inspector.js";
import { libraryRoutes } from "./routes/library.js";
import { nodesRoutes } from "./routes/nodes.js";
import { search } from "./routes/search.js";
import { statsRoutes } from "./routes/stats.js";
import { getGapAlbums, getGapTracks } from "./routes/tag-manager.js";
import { nodeSummary } from "./summary.js";

// #133: a plays row is a single play, or one track's total imported from
// Apple Music (playCounts.ts). These check every surface that reads plays
// against one imported row holding 5, and that no query in server/src
// counts plays' rows or reads their time bare.

describe("queries over plays", () => {
  // Every string literal in server/src that reads the plays table, outside
  // the specs. A template's ${…} can't hide one: the fragments it would
  // insert are playCounts.ts's own.
  function playsQueries(): { file: string; sql: string }[] {
    const root = path.join(import.meta.dir);
    const found: { file: string; sql: string }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) {
          const text = readFileSync(full, "utf8");
          for (const match of text.matchAll(/`[^`]*`|"[^"\n]*"/g)) {
            if (/\b(FROM|JOIN)\s+plays\b/i.test(match[0]))
              found.push({ file: path.relative(root, full), sql: match[0] });
          }
        }
      }
    };
    walk(root);
    return found;
  }

  it("finds the readers it guards", () => {
    const files = new Set(playsQueries().map((q) => q.file));
    for (const file of ["routes/stats.ts", "routes/search.ts", "routes/library.ts", "insights/listening.ts"]) {
      expect(files.has(file)).toBe(true);
    }
  });

  it("never counts plays' rows: an imported total is one row holding many plays", () => {
    const counting = playsQueries().filter((q) =>
      /COUNT\(\s*(\*|1|\w*\.?id)\s*\)[^()]*?\b(FROM|JOIN)\s+plays\b/i.test(q.sql),
    );
    expect(counting).toEqual([]);
  });

  it("never reads started_at bare: an undated total's is ''", () => {
    const bare = playsQueries().filter((q) =>
      /\b(MAX|MIN|julianday|date|datetime)\(\s*(\w+\.)?started_at\s*[,)]/i.test(q.sql),
    );
    expect(bare).toEqual([]);
  });
});

describe("an imported total of 5 on every surface", () => {
  let db: Database;
  let lib: TestLibrary;
  let imported: { id: number; tracks: number[] };
  let other: { id: number; tracks: number[] };
  let played: { id: number; tracks: number[] };
  let undated: { id: number; tracks: number[] };

  function importTotal(rec: number, count: number, daysAgo: number | null) {
    const file = db.prepare("SELECT id FROM files WHERE recording_node_id = ?").get(rec) as { id: number };
    const at = daysAgo == null ? "" : new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    db.prepare(
      `INSERT INTO plays (recording_node_id, file_id, started_at, ms_played, source, play_count)
       VALUES (?, ?, ?, 0, 'apple-music', ?)`,
    ).run(rec, file.id, at, count);
  }

  beforeEach(() => {
    db = openDb(":memory:");
    lib = new TestLibrary(db);
    // "Ferry" is in every track's title, so one search ranks them all.
    imported = lib.album("Harbour Lights", "Ferry Night", { tracks: 2 });
    other = lib.album("Harbour Lights", "Ferry Songs", { tracks: 1 });
    played = lib.album("Quay Street", "Ferry Terminal", { tracks: 1 });
    undated = lib.album("Lantern Choir", "Ferry Hymns", { tracks: 1 });
    lib.aggregate();
    // Music's 5 plays, last 10 days ago, against 3 and 2 single plays.
    importTotal(imported.tracks[0]!, 5, 10);
    lib.play(other.tracks[0]!, 3, 40);
    lib.play(played.tracks[0]!, 2, 0);
    // A count Music has no date for.
    importTotal(undated.tracks[0]!, 4, null);
  });

  it("GET /stats: top track, artist and album", async () => {
    const app = Fastify();
    await app.register(statsRoutes(db));
    const body = (await app.inject("/stats")).json();
    expect(body.topTrack).toEqual({ id: imported.tracks[0], title: "Ferry Night 1", playCount: 5 });
    expect(body.topArtist).toEqual({ id: lib.artist("Harbour Lights"), title: "Harbour Lights", playCount: 8 });
    expect(body.topAlbum).toEqual({ id: imported.id, title: "Ferry Night", playCount: 5 });
  });

  it("an artist's top album, on the node card", () => {
    expect(nodeSummary(db, lib.artist("Harbour Lights"))).toMatchObject({ topAlbum: { id: imported.id } });
  });

  it("search ranks by plays", () => {
    const tracks = search(db, "ferry", { perKind: 10, total: 40 }).filter((h) => h.type === "recording");
    expect(tracks.map((h) => h.title).slice(0, 4)).toEqual([
      "Ferry Night 1",
      "Ferry Hymns 1",
      "Ferry Songs 1",
      "Ferry Terminal 1",
    ]);
  });

  it("GET /nodes/:id: a track's play count", async () => {
    const app = Fastify();
    await app.register(nodesRoutes(db));
    expect((await app.inject(`/nodes/${imported.tracks[0]}`)).json().playCount).toBe(5);
    expect((await app.inject(`/nodes/${other.tracks[0]}`)).json().playCount).toBe(3);
  });

  it("the library's recently played: by Music's last play date, and an undated total never as recent", async () => {
    const app = Fastify();
    await app.register(libraryRoutes(db));
    const res = await app.inject("/library/albums?sort=recentlyPlayed&dir=desc&limit=10");
    const order = (res.json().items as { id: number }[]).map((a) => a.id);
    // Today, 10 days ago, 40 days ago; then the undated one with the never
    // played (by id), whichever way the sort runs.
    expect(order).toEqual([played.id, imported.id, other.id, undated.id]);
    const asc = (await app.inject("/library/albums?sort=recentlyPlayed&dir=asc&limit=10")).json().items as {
      id: number;
    }[];
    expect(asc.map((a) => a.id)).toEqual([other.id, imported.id, played.id, undated.id]);
  });

  it("removing a folder warns about every play it would take", () => {
    const root = (db.prepare("SELECT id FROM library_roots").get() as { id: number }).id;
    expect(countLibraryRootContents(db, root).plays).toBe(5 + 3 + 2 + 4);
  });

  it("metadata gaps: an album's and a track's plays, and the order by plays", () => {
    const albums = getGapAlbums(db, { kinds: ["bpm"] }, "plays", "desc", 0, 10).items;
    expect(albums.map((a) => [a.id, a.plays])).toEqual([
      [imported.id, 5],
      [undated.id, 4],
      [other.id, 3],
      [played.id, 2],
    ]);
    const tracks = getGapTracks(db, imported.id, { kinds: ["bpm"] }, 0, 10).items;
    expect(tracks.map((t) => [t.id, t.plays])).toEqual([
      [imported.tracks[0], 5],
      [imported.tracks[1], 0],
    ]);
  });

  it("the database inspector counts plays, not rows", () => {
    expect(dbInspectorSnapshot(db, "/nonexistent.db", "/nonexistent-covers").schema.plays).toBe(14);
  });

  it("Insights: totals count in full, but not towards plays in the last 30 days", () => {
    const cards = listening(db);
    expect(cards.mostPlayed.tracks.slice(0, 2).map((t) => [t.node.id, t.plays])).toEqual([
      [imported.tracks[0], 5],
      [undated.tracks[0], 4],
    ]);
    expect(cards.mostPlayed.artists[0]).toMatchObject({ node: { title: "Harbour Lights" }, plays: 8 });
    // The total's last play was 10 days ago, but its other four could have
    // been years ago: on repeat counts only the two single plays today.
    expect(cards.onRepeat).toEqual([]);
  });

  it("Insights' rediscover: an imported date is a last play, and no date is never gone quiet", () => {
    const quiet = lib.album("Old Favourite", "Long Ago", { tracks: 1 });
    const unknown = lib.album("Undated Favourite", "Some Time", { tracks: 1 });
    lib.aggregate();
    importTotal(quiet.tracks[0]!, 12, 200);
    importTotal(unknown.tracks[0]!, 12, null);
    const names = listening(db).rediscover.map((r) => r.artist.title);
    expect(names).toContain("Old Favourite");
    expect(names).not.toContain("Undated Favourite");
  });

  it("a re-import's new totals reach Insights without waiting out the cache", () => {
    expect(listening(db).mostPlayed.tracks[0]!.plays).toBe(5);
    db.prepare("UPDATE plays SET play_count = 7 WHERE source = 'apple-music' AND play_count = 5").run();
    expect(listening(db).mostPlayed.tracks[0]!.plays).toBe(7);
  });
});
