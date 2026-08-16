import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { coverTargetNode, findFolderArt, pickFrontCover, recordCover, resolveCover } from "./extract.js";

describe("pickFrontCover", () => {
  const bytes = (n: number) => new Uint8Array([n]);

  it("returns null when a file carries no art", () => {
    expect(pickFrontCover(undefined)).toBeNull();
    expect(pickFrontCover([])).toBeNull();
  });

  it("prefers the picture flagged as a front cover over earlier ones", () => {
    const chosen = pickFrontCover([
      { data: bytes(1), type: "Media (e.g. label side of CD)", format: "image/png" },
      { data: bytes(2), type: "Cover (front)", format: "image/jpeg" },
      { data: bytes(3), type: "Cover (back)", format: "image/jpeg" },
    ]);

    expect(chosen?.data).toEqual(Buffer.from([2]));
    expect(chosen?.mime).toBe("image/jpeg");
  });

  // Plenty of real files attach exactly one unlabelled image, and it is
  // essentially always the front cover.
  it("falls back to the first picture when none is labelled", () => {
    const chosen = pickFrontCover([{ data: bytes(9), format: "image/png" }]);
    expect(chosen?.data).toEqual(Buffer.from([9]));
  });

  it("does not mistake a back cover for a front one", () => {
    const chosen = pickFrontCover([{ data: bytes(4), type: "Cover (back)", format: "image/jpeg" }]);
    expect(chosen?.data).toEqual(Buffer.from([4]));
  });
});

describe("findFolderArt", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "legato-cover-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const track = () => path.join(dir, "01 - track.flac");

  it("returns null for a folder with no art", async () => {
    await writeFile(path.join(dir, "notes.txt"), "x");
    expect(await findFolderArt(track())).toBeNull();
  });

  it("finds a conventionally-named cover", async () => {
    await writeFile(path.join(dir, "cover.jpg"), "x");
    expect((await findFolderArt(track()))?.path).toBe(path.join(dir, "cover.jpg"));
  });

  it("is case-insensitive about the name and the extension", async () => {
    await writeFile(path.join(dir, "Folder.JPG"), "x");
    expect((await findFolderArt(track()))?.path).toBe(path.join(dir, "Folder.JPG"));
  });

  // Deterministic ordering matters: a folder holding several candidates must
  // resolve identically on every scan, regardless of directory listing order.
  it("prefers cover over other accepted names", async () => {
    await writeFile(path.join(dir, "front.png"), "x");
    await writeFile(path.join(dir, "cover.jpg"), "x");
    await writeFile(path.join(dir, "album.webp"), "x");
    expect((await findFolderArt(track()))?.path).toBe(path.join(dir, "cover.jpg"));
  });

  it("ignores images that are not cover art", async () => {
    await writeFile(path.join(dir, "band-photo.jpg"), "x");
    await writeFile(path.join(dir, "scan-page-3.png"), "x");
    expect(await findFolderArt(track())).toBeNull();
  });

  it("returns null rather than throwing when the folder is gone", async () => {
    expect(await findFolderArt("/nonexistent/dir/track.flac")).toBeNull();
  });
});

describe("cover attachment", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function recording(title: string): number {
    return (
      db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(title) as {
        id: number;
      }
    ).id;
  }

  function release(title: string): number {
    return (
      db.prepare("INSERT INTO nodes (type, title) VALUES ('release', ?) RETURNING id").get(title) as {
        id: number;
      }
    ).id;
  }

  it("attaches art to the release a recording appears on, not the recording", () => {
    const rec = recording("Come Together");
    const rel = release("Abbey Road");
    db.prepare(
      "INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'appears_on', 'local')",
    ).run(rec, rel);

    expect(coverTargetNode(db, rec)).toBe(rel);
  });

  // A loose file with no album tag still needs to render somewhere.
  it("falls back to the recording when there is no release", () => {
    const rec = recording("Untitled Demo");
    expect(coverTargetNode(db, rec)).toBe(rec);
  });

  function artist(title: string): number {
    return (
      db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(title) as { id: number }
    ).id;
  }

  function album(title: string, primaryArtistNodeId: number, trackCount: number): number {
    const node = release(title);
    db.prepare(
      "INSERT INTO albums (node_id, primary_artist_node_id, track_count) VALUES (?, ?, ?)",
    ).run(node, primaryArtistNodeId, trackCount);
    return node;
  }

  // G-7: an artist node has no appears_on edge of its own — falls through
  // to their most-represented album (by track_count) instead.
  it("resolves an artist to their most-represented album", () => {
    const theBeatles = artist("The Beatles");
    album("Please Please Me", theBeatles, 14);
    const abbeyRoad = album("Abbey Road", theBeatles, 17);

    expect(coverTargetNode(db, theBeatles)).toBe(abbeyRoad);
  });

  it("falls back to the artist's own id when they have no albums at all", () => {
    const unknownArtist = artist("Nobody");
    expect(coverTargetNode(db, unknownArtist)).toBe(unknownArtist);
  });

  it("returns null when a node has no art at all", () => {
    expect(resolveCover(db, release("Nothing"))).toBeNull();
  });

  it("prefers a manual override over everything the scan found", () => {
    const rel = release("Help!");
    recordCover(db, { nodeId: rel, source: "folder", hash: "folderhash", mime: null });
    recordCover(db, { nodeId: rel, source: "embedded", hash: "embeddedhash", mime: "image/jpeg" });
    recordCover(db, { nodeId: rel, source: "caa", hash: "caahash", mime: "image/jpeg" });
    recordCover(db, { nodeId: rel, source: "manual", hash: "manualhash", mime: "image/png" });

    expect(resolveCover(db, rel)?.hash).toBe("manualhash");
  });

  it("prefers embedded art over a folder image and both over the archive", () => {
    const rel = release("Revolver");
    recordCover(db, { nodeId: rel, source: "caa", hash: "caahash", mime: null });
    recordCover(db, { nodeId: rel, source: "folder", hash: "folderhash", mime: null });
    expect(resolveCover(db, rel)?.source).toBe("folder");

    recordCover(db, { nodeId: rel, source: "embedded", hash: "embeddedhash", mime: null });
    expect(resolveCover(db, rel)?.source).toBe("embedded");
  });

  // Re-scanning a changed file must replace that node's embedded art rather
  // than pile up a new row on every mtime change.
  it("replaces art from the same source instead of duplicating it", () => {
    const rel = release("Rubber Soul");
    recordCover(db, { nodeId: rel, source: "embedded", hash: "first", mime: null });
    recordCover(db, { nodeId: rel, source: "embedded", hash: "second", mime: null });

    const rows = db.prepare("SELECT hash FROM cover_art WHERE node_id = ?").all(rel);
    expect(rows).toEqual([{ hash: "second" }]);
  });

  it("keeps sources independent so removing an override reveals what was found", () => {
    const rel = release("Let It Be");
    recordCover(db, { nodeId: rel, source: "embedded", hash: "embeddedhash", mime: null });
    recordCover(db, { nodeId: rel, source: "manual", hash: "manualhash", mime: null });
    expect(resolveCover(db, rel)?.hash).toBe("manualhash");

    db.prepare("DELETE FROM cover_art WHERE node_id = ? AND source = 'manual'").run(rel);
    expect(resolveCover(db, rel)?.hash).toBe("embeddedhash");
  });

  it("drops cover rows when their node goes away", () => {
    const rel = release("Deleted");
    recordCover(db, { nodeId: rel, source: "embedded", hash: "orphan", mime: null });

    db.prepare("DELETE FROM nodes WHERE id = ?").run(rel);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cover_art").get()).toEqual({ n: 0 });
  });
});
