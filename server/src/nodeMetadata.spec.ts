import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import { openDb } from "./db.js";
import { nodeMetadata } from "./nodeMetadata.js";

let db: Database;
let rootId = 0;
let nextFile = 0;

beforeEach(() => {
  db = openDb(":memory:");
  rootId = (db.prepare("INSERT INTO library_roots (path) VALUES ('/music') RETURNING id").get() as { id: number }).id;
  nextFile = 0;
});

function makeNode(type: string, title: string, mbid: string | null = null): number {
  return (
    db.prepare("INSERT INTO nodes (type, title, mbid) VALUES (?, ?, ?) RETURNING id").get(type, title, mbid) as {
      id: number;
    }
  ).id;
}

function addEdge(from: number, to: number, type: string): void {
  db.prepare("INSERT INTO edges (from_node, to_node, type, source) VALUES (?, ?, ?, 'local')").run(from, to, type);
}

function addFile(
  recordingNodeId: number,
  tags: { trackNo?: number; releaseDate?: string; releaseType?: string; label?: string } = {},
): void {
  db.prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size,
                        track_no, release_date, release_type, label)
     VALUES (?, ?, ?, datetime('now'), 0, ?, ?, ?, ?)`,
  ).run(
    recordingNodeId,
    rootId,
    `/music/${recordingNodeId}-${nextFile++}.flac`,
    tags.trackNo ?? null,
    tags.releaseDate ?? null,
    tags.releaseType ?? null,
    tags.label ?? null,
  );
}

function provenance(
  nodeId: number,
  field: string,
  value: string,
  extra: { confidence?: number; active?: boolean } = {},
): void {
  db.prepare(
    `INSERT INTO field_provenance (node_id, field, value, source, confidence, is_active)
     VALUES (?, ?, ?, 'musicbrainz', ?, ?)`,
  ).run(nodeId, field, value, extra.confidence ?? 1, extra.active === false ? 0 : 1);
}

// An album whose files carry no label or type tags, but which MusicBrainz
// matched: the case that showed "–" on every row.
function untaggedAlbum() {
  const album = makeNode("release", "Blood on the Tracks");
  const first = makeNode("recording", "Tangled Up in Blue", "rec-mbid-1");
  const second = makeNode("recording", "Simple Twist of Fate");
  addEdge(first, album, "appears_on");
  addEdge(second, album, "appears_on");
  addFile(second, { trackNo: 2, releaseDate: "1975-01-20" });
  addFile(first, { trackNo: 1, releaseDate: "1975-01-17" });
  provenance(album, "release_mbid", "release-mbid-1");
  provenance(album, "label_name", "Columbia");
  provenance(album, "first_release_date", "1975-01-20");
  return { album, first, second };
}

describe("nodeMetadata", () => {
  it("returns null for a node that doesn't exist, so the route can 404", () => {
    expect(nodeMetadata(db, 999)).toBeNull();
  });

  it("fills an album's empty tags from MusicBrainz, and says so", () => {
    const { album } = untaggedAlbum();

    expect(nodeMetadata(db, album)).toEqual({
      // From track 1's file, though track 2's was added first.
      releaseDate: { value: "1975-01-17", source: "tags" },
      releaseType: null,
      label: { value: "Columbia", source: "musicbrainz" },
      mbid: { value: "release-mbid-1", source: "musicbrainz" },
    });
  });

  it("lets a track's own tags win, and borrows its album's MusicBrainz label when the tag is empty", () => {
    const { first, second } = untaggedAlbum();
    addFile(makeNode("recording", "unrelated"), { label: "Asylum" });
    db.prepare("UPDATE files SET release_type = 'Album' WHERE recording_node_id = ?").run(first);

    expect(nodeMetadata(db, first)).toMatchObject({
      releaseType: { value: "Album", source: "tags" },
      label: { value: "Columbia", source: "musicbrainz" },
      mbid: { value: "rec-mbid-1", source: "musicbrainz" },
    });
    expect(nodeMetadata(db, second)!.mbid).toBeNull();
  });

  it("prefers a tag over MusicBrainz when both have a value", () => {
    const { album, first } = untaggedAlbum();
    db.prepare("UPDATE files SET label = 'Columbia Records' WHERE recording_node_id = ?").run(first);

    expect(nodeMetadata(db, album)!.label).toEqual({ value: "Columbia Records", source: "tags" });
  });

  it("ignores inactive MusicBrainz rows and picks the most confident of the rest", () => {
    const album = makeNode("release", "Rubber Soul");
    provenance(album, "label_name", "Retracted", { active: false });
    provenance(album, "label_name", "Capitol", { confidence: 0.6 });
    provenance(album, "label_name", "Parlophone", { confidence: 1 });

    expect(nodeMetadata(db, album)!.label).toEqual({ value: "Parlophone", source: "musicbrainz" });
  });

  it("gives an artist its MusicBrainz id and nothing else", () => {
    const artist = makeNode("artist", "Bob Dylan");
    provenance(artist, "artist_mbid", "artist-mbid-1");

    expect(nodeMetadata(db, artist)).toEqual({
      releaseDate: null,
      releaseType: null,
      label: null,
      mbid: { value: "artist-mbid-1", source: "musicbrainz" },
    });
  });
});
