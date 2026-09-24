import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { getImportReport, importM3U, previewM3UImport } from "./playlist-import.js";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

function insertLibraryRoot(path: string): number {
  const row = db.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(path) as { id: number };
  return row.id;
}

// Mirrors scanner.ts's own shape closely enough for matching to exercise:
// a recording node, its recordings row (canonical duration), a files row
// at an absolute path, and — when an artist is given — a performed_by
// edge, the same one match/edges.ts derives from a real scan.
function insertTrack(opts: {
  libraryRootId: number;
  filePath: string;
  title: string;
  artist?: string;
  durationMs: number;
}): number {
  const node = db.prepare("INSERT INTO nodes (type, title) VALUES ('recording', ?) RETURNING id").get(opts.title) as {
    id: number;
  };
  db.prepare("INSERT INTO recordings (node_id, canonical_duration_ms) VALUES (?, ?)").run(node.id, opts.durationMs);
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size)
     VALUES (?, ?, ?, datetime('now'), 0)`,
  ).run(node.id, opts.libraryRootId, opts.filePath);

  if (opts.artist) {
    const artistNode = db
      .prepare("SELECT id FROM nodes WHERE type = 'artist' AND lower(trim(title)) = lower(trim(?))")
      .get(opts.artist) as { id: number } | undefined;
    const artistId =
      artistNode?.id ??
      (db.prepare("INSERT INTO nodes (type, title) VALUES ('artist', ?) RETURNING id").get(opts.artist) as { id: number })
        .id;
    db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, 'performed_by', 'local')").run(
      node.id,
      artistId,
    );
  }

  return node.id;
}

describe("previewM3UImport / importM3U — direct path match", () => {
  it("matches an entry whose path is already correct for this machine", () => {
    const root = insertLibraryRoot("/mnt/music");
    const nodeId = insertTrack({
      libraryRootId: root,
      filePath: "/mnt/music/Air/Moon Safari/01 La Femme d'Argent.flac",
      title: "La Femme d'Argent",
      durationMs: 265000,
    });

    const content = "/mnt/music/Air/Moon Safari/01 La Femme d'Argent.flac\n";
    const preview = previewM3UImport(db, content, null);
    expect(preview.totalEntries).toBe(1);
    expect(preview.matchedByPath).toBe(1);
    expect(preview.unmatchedByPath).toBe(0);

    const result = importM3U(db, "moon-safari.m3u", content, null);
    expect(result.matchedByPathCount).toBe(1);
    expect(result.missingCount).toBe(0);
    expect(result.entries[0].matchedNodeId).toBe(nodeId);
    expect(result.entries[0].matchType).toBe("path");
  });

  it("matches case-insensitively, covering NTFS/APFS-cased exports", () => {
    const root = insertLibraryRoot("/mnt/music");
    insertTrack({ libraryRootId: root, filePath: "/mnt/music/Track.flac", title: "Track", durationMs: 200000 });

    const preview = previewM3UImport(db, "/MNT/MUSIC/TRACK.FLAC\n", null);
    expect(preview.matchedByPath).toBe(1);
  });
});

describe("prefix remap suggestion — Windows path fixture", () => {
  it("suggests replacing the playlist's common Windows prefix with a configured library root, with a match-count preview", () => {
    const root = insertLibraryRoot("/mnt/music");
    insertTrack({
      libraryRootId: root,
      filePath: "/mnt/music/Radiohead/OK Computer/06 Karma Police.flac",
      title: "Karma Police",
      durationMs: 253000,
    });
    insertTrack({
      libraryRootId: root,
      filePath: "/mnt/music/Radiohead/OK Computer/10 No Surprises.flac",
      title: "No Surprises",
      durationMs: 257000,
    });

    const content =
      "D:\\Music\\Radiohead\\OK Computer\\06 Karma Police.flac\n" +
      "D:\\Music\\Radiohead\\OK Computer\\10 No Surprises.flac\n";

    const preview = previewM3UImport(db, content, null);
    expect(preview.matchedByPath).toBe(0);
    expect(preview.commonPrefix).toBe("D:/Music/Radiohead/OK Computer/");
    expect(preview.suggestions).toHaveLength(1);
    expect(preview.suggestions[0].libraryRootPath).toBe("/mnt/music");
    expect(preview.suggestions[0].previewMatchCount).toBe(2);

    const remap = { from: preview.commonPrefix!, to: preview.suggestions[0].replacement };
    const afterRemap = previewM3UImport(db, content, remap);
    expect(afterRemap.matchedByPath).toBe(2);

    const result = importM3U(db, "radiohead.m3u", content, remap);
    expect(result.matchedByPathCount).toBe(2);
    expect(result.entries.every((e) => e.matchType === "path")).toBe(true);
  });

  it("derives the top-level root itself when the playlist spans multiple artists — the issue's own example", () => {
    const root = insertLibraryRoot("/mnt/music");
    insertTrack({
      libraryRootId: root,
      filePath: "/mnt/music/Radiohead/OK Computer/06 Karma Police.flac",
      title: "Karma Police",
      durationMs: 253000,
    });
    insertTrack({
      libraryRootId: root,
      filePath: "/mnt/music/Air/Moon Safari/01 La Femme d'Argent.flac",
      title: "La Femme d'Argent",
      durationMs: 265000,
    });

    const content = "D:\\Music\\Radiohead\\OK Computer\\06 Karma Police.flac\nD:\\Music\\Air\\Moon Safari\\01 La Femme d'Argent.flac\n";

    const preview = previewM3UImport(db, content, null);
    // Two different artists share nothing deeper than the top-level
    // "D:\Music\" folder, matching the issue text's own worked example.
    expect(preview.commonPrefix).toBe("D:/Music/");
    expect(preview.suggestions[0].replacement).toBe("/mnt/music/");
    expect(preview.suggestions[0].previewMatchCount).toBe(2);
  });
});

describe("prefix remap suggestion — macOS path fixture", () => {
  it("suggests replacing a /Volumes prefix the same way", () => {
    const root = insertLibraryRoot("/home/danielc/music");
    insertTrack({
      libraryRootId: root,
      filePath: "/home/danielc/music/Air/Moon Safari/01 La Femme d'Argent.flac",
      title: "La Femme d'Argent",
      durationMs: 265000,
    });

    const content = "/Volumes/Music/Air/Moon Safari/01 La Femme d'Argent.flac\n";
    const preview = previewM3UImport(db, content, null);
    expect(preview.commonPrefix).toBe("/Volumes/Music/Air/Moon Safari/");
    expect(preview.suggestions[0].previewMatchCount).toBe(1);
    // Derived from the real file's own path, not just the bare configured
    // root — the single unmatched entry's common "prefix" is its whole
    // containing folder here, so the correct replacement has to include
    // the Artist/Album segments the root alone doesn't carry.
    expect(preview.suggestions[0].replacement).toBe("/home/danielc/music/Air/Moon Safari/");
  });
});

describe("metadata fallback — artist + title + duration ±2s", () => {
  it("matches by EXTINF metadata when the path can't be resolved at all", () => {
    const root = insertLibraryRoot("/mnt/music");
    const nodeId = insertTrack({
      libraryRootId: root,
      filePath: "/mnt/music/Boards of Canada/Roygbiv.flac",
      title: "Roygbiv",
      artist: "Boards of Canada",
      durationMs: 145000,
    });

    const content = "#EXTINF:144,Boards of Canada - Roygbiv\nZ:\\Unrelated\\path\\roygbiv.mp3\n";
    const result = importM3U(db, "list.m3u", content, null);

    expect(result.entries[0].matchType).toBe("metadata");
    expect(result.entries[0].matchedNodeId).toBe(nodeId);
    expect(result.matchedByMetadataCount).toBe(1);
  });

  it("rejects a metadata candidate outside the ±2s duration tolerance", () => {
    const root = insertLibraryRoot("/mnt/music");
    insertTrack({
      libraryRootId: root,
      filePath: "/mnt/music/Track.flac",
      title: "Roygbiv",
      artist: "Boards of Canada",
      durationMs: 145000,
    });

    // 5 seconds off — outside tolerance.
    const content = "#EXTINF:140,Boards of Canada - Roygbiv\nZ:\\gone.mp3\n";
    const result = importM3U(db, "list.m3u", content, null);

    expect(result.entries[0].matchType).toBe("missing");
    expect(result.entries[0].reason).toContain("±2s");
  });

  it("accepts a candidate exactly at the ±2s boundary", () => {
    const root = insertLibraryRoot("/mnt/music");
    const nodeId = insertTrack({
      libraryRootId: root,
      filePath: "/mnt/music/Track.flac",
      title: "Roygbiv",
      artist: "Boards of Canada",
      durationMs: 145000,
    });

    const content = "#EXTINF:143,Boards of Canada - Roygbiv\nZ:\\gone.mp3\n";
    const result = importM3U(db, "list.m3u", content, null);
    expect(result.entries[0].matchedNodeId).toBe(nodeId);
  });

  it("falls straight to missing, with a reason, when there's no EXTINF metadata to fall back on", () => {
    const content = "Z:\\completely\\unknown\\path.mp3\n";
    const result = importM3U(db, "list.m3u", content, null);
    expect(result.entries[0].matchType).toBe("missing");
    expect(result.entries[0].matchedNodeId).toBeNull();
    expect(result.entries[0].reason).toMatch(/no.*#EXTINF metadata/);
  });

  it("falls to missing, with a duration-specific reason, when EXTINF has artist/title but an unknown (-1) duration", () => {
    const content = "#EXTINF:-1,Boards of Canada - Roygbiv\nZ:\\gone.mp3\n";
    const result = importM3U(db, "list.m3u", content, null);
    expect(result.entries[0].matchType).toBe("missing");
    expect(result.entries[0].reason).toMatch(/no duration to match by/);
  });
});

describe("importM3U — playlist creation and the persisted report", () => {
  it("creates the playlist from whatever matched, naming it after the file when no name is given", () => {
    const root = insertLibraryRoot("/mnt/music");
    insertTrack({ libraryRootId: root, filePath: "/mnt/music/a.flac", title: "A", durationMs: 100000 });

    const result = importM3U(db, "Road Trip.m3u", "/mnt/music/a.flac\n", null);
    expect(result.playlist.name).toBe("Road Trip");

    const tracks = db.prepare("SELECT node_id FROM playlist_tracks WHERE playlist_id = ?").all(result.playlist.id);
    expect(tracks).toHaveLength(1);
  });

  it("still creates the playlist when nothing matched at all — partial import, not a failure", () => {
    const result = importM3U(db, "empty.m3u", "Z:\\nowhere.mp3\n", null);
    expect(result.playlist).toBeTruthy();
    expect(result.matchedByPathCount).toBe(0);
    expect(result.missingCount).toBe(1);
    const tracks = db.prepare("SELECT * FROM playlist_tracks WHERE playlist_id = ?").all(result.playlist.id);
    expect(tracks).toHaveLength(0);
  });

  it("persists a report that stays fetchable by playlist id after the import request ends", () => {
    const root = insertLibraryRoot("/mnt/music");
    insertTrack({ libraryRootId: root, filePath: "/mnt/music/a.flac", title: "A", durationMs: 100000 });

    const content = "/mnt/music/a.flac\nZ:\\missing.mp3\n";
    const result = importM3U(db, "mixed.m3u", content, null);

    const report = getImportReport(db, result.playlist.id);
    expect(report).not.toBeNull();
    expect(report!.sourceFilename).toBe("mixed.m3u");
    expect(report!.entries).toHaveLength(2);
    expect(report!.entries[0].matchType).toBe("path");
    expect(report!.entries[1].matchType).toBe("missing");
  });

  it("returns null for a playlist that was never imported into", () => {
    const playlist = db.prepare("INSERT INTO playlists (name) VALUES ('Manual') RETURNING id").get() as { id: number };
    expect(getImportReport(db, playlist.id)).toBeNull();
  });
});
