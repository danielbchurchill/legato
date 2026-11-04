import type { Database } from "../sqlite.js";
import { albumFolder, albumIdentities, type AlbumFile, type AlbumIdentity } from "./albumIdentity.js";

// Issue #465: the album node a file's appears_on edge points at. Which album
// a file is on is match/albumIdentity.ts's to say, from every file of its
// album folder and title; this reads those files, and finds that album's
// node through release_keys (migration 0045), or makes it.
//
// Each album node is reached by up to two kinds of key. Its artist key
// (title + the artist the album is by) belongs to it alone. Its folder key
// (title + album folder) is how a compilation finds it: the first album of
// that title in that folder holds it, and a later one in the same folder,
// which only its artist tells apart, doesn't take it over.
//
// - An album by one artist goes to the node its artist key names. With no
//   such node yet, it goes to the node its folder key names, as long as no
//   artist has claimed that one: an album without an ALBUMARTIST or ARTIST
//   keeps its node when the tag arrives. Otherwise it's a new album.
// - A compilation goes to the node its folder key names, or a new one.

function nodeForKey(db: Database, key: string): number | null {
  const row = db.prepare("SELECT node_id FROM release_keys WHERE key = ?").get(key) as { node_id: number } | undefined;
  return row?.node_id ?? null;
}

function hasArtistKey(db: Database, nodeId: number): boolean {
  return (
    db.prepare(`SELECT 1 FROM release_keys WHERE node_id = ? AND key LIKE '["artist",%' LIMIT 1`).get(nodeId) !==
    undefined
  );
}

function addKey(db: Database, key: string, nodeId: number): void {
  db.prepare("INSERT OR IGNORE INTO release_keys (key, node_id) VALUES (?, ?)").run(key, nodeId);
}

/** The node of the album `identity` names, or null when there isn't one yet.
 *  Reads only. */
export function findRelease(db: Database, identity: AlbumIdentity): number | null {
  if (identity.artistKey) {
    const byArtist = nodeForKey(db, identity.artistKey);
    if (byArtist !== null) return byArtist;
    const byFolder = nodeForKey(db, identity.folderKey);
    return byFolder !== null && !hasArtistKey(db, byFolder) ? byFolder : null;
  }
  return nodeForKey(db, identity.folderKey);
}

/** The node of the album `identity` names, made if there isn't one, with
 *  the identity's keys pointed at it. The one place an album node is found
 *  or made from a file's tags (match/edges.ts). */
export function findOrCreateRelease(db: Database, identity: AlbumIdentity): number {
  let nodeId = findRelease(db, identity);
  if (nodeId === null) {
    nodeId = (
      db.prepare("INSERT INTO nodes (type, title) VALUES ('release', ?) RETURNING id").get(identity.title) as {
        id: number;
      }
    ).id;
  }
  if (identity.artistKey) addKey(db, identity.artistKey, nodeId);
  addKey(db, identity.folderKey, nodeId);
  return nodeId;
}

// What the album rule reads about a file, straight from its row: a malformed
// tags_raw reads as no tags rather than failing the query. The disc and track
// columns come first, as the scan writes them; tags_raw's copy covers a row
// written without them. match/edges.ts reads the same facts for the file it
// derives from the row and tags it already has.
const tag = (field: string) => `CASE WHEN json_valid(tags_raw) THEN json_extract(tags_raw, '$.${field}') END`;
export const ALBUM_FILE_COLUMNS = `id, file_path AS path, ${tag("album")} AS album,
  ${tag("albumartist")} AS albumartist, ${tag("artist")} AS artist,
  COALESCE(disc_no, ${tag("discNo")}) AS discNo, COALESCE(track_no, ${tag("trackNo")}) AS trackNo`;

function separators(value: string): number {
  return value.length - value.replaceAll("/", "").replaceAll("\\", "").length;
}

// Every present file that may share `folder` as its album folder: those in
// it, in a disc folder inside it ("Album/CD1/"), and in a folder named after
// one of its discs beside it ("Album CD2/", and "Album CD2/CD2/"). Each of
// their paths is the folder's path followed by a separator, or by the space,
// punctuation, bracket or non-ASCII character a disc suffix can start with
// (albumIdentity.ts), so the query reads just those ranges of
// files.file_path's unique index: never "Album 2/" or "Albums/", and never
// "5000/" for "5/". The depth test keeps a folder's whole subtree from being
// fetched when loose files sit high up. The caller keeps those whose album
// folder this is (albumFolder).
const FOLLOWERS: [string, string][] = [
  ["\t", "0"], // tab, space, punctuation up to "/"
  [":", "<"], // ":" and ";"
  ["[", "]"], // "[" and "\"
  ["_", "`"],
  ["{", "|"],
  ["\u0080", "\uffff"], // dashes, other spaces
];

export const ALBUM_FOLDER_SQL = `SELECT ${ALBUM_FILE_COLUMNS} FROM files
  WHERE (${FOLLOWERS.map(() => "(file_path >= ? AND file_path < ?)").join(" OR ")})
    AND missing_since IS NULL
    AND length(file_path) - length(replace(replace(file_path, '/', ''), '\\', '')) <= ?`;

export function albumFolderParams(folder: string): (string | number)[] {
  return [...FOLLOWERS.flatMap(([from, to]) => [folder + from, folder + to]), separators(folder) + 2];
}

function readAlbumFolder(db: Database, folder: string): AlbumFile[] {
  const rows = db.prepare(ALBUM_FOLDER_SQL).all(...albumFolderParams(folder)) as AlbumFile[];
  return rows.filter((row) => albumFolder(row.path) === folder);
}

function sameFacts(a: AlbumFile, b: AlbumFile): boolean {
  return (
    a.path === b.path &&
    a.album === b.album &&
    a.albumartist === b.albumartist &&
    a.artist === b.artist &&
    a.discNo === b.discNo &&
    a.trackNo === b.trackNo
  );
}

type FolderAlbums = Map<number, { file: AlbumFile; identity: AlbumIdentity }>;

function resolveFolder(db: Database, folder: string, file: AlbumFile): FolderAlbums {
  const files = readAlbumFolder(db, folder).filter((other) => other.id !== file.id);
  files.push(file);
  const identities = albumIdentities(files);
  const albums: FolderAlbums = new Map();
  for (const other of files) {
    const identity = identities.get(other.id);
    if (identity) albums.set(other.id, { file: other, identity });
  }
  return albums;
}

/** Album folders already read and decided, for a pass that derives many
 *  files (recompute, a scan's collapse stage), so each folder is read once
 *  rather than once per file. A file whose facts changed since its folder
 *  was read has the folder read again. One pass only: it doesn't notice a
 *  sibling's tags changing under it, which the next pass does. */
export class AlbumFolders {
  readonly #db: Database;
  readonly #folders = new Map<string, FolderAlbums>();

  constructor(db: Database) {
    this.#db = db;
  }

  identityOf(file: AlbumFile): AlbumIdentity | null {
    return albumIdentityOf(this.#db, file, this.#folders);
  }
}

/** Which album `file` is on, decided with every present file of its album
 *  folder (match/albumIdentity.ts's rule), or null when it has no ALBUM tag.
 *  With `folders`, a folder already decided isn't read again. */
export function albumIdentityOf(
  db: Database,
  file: AlbumFile,
  folders?: Map<string, FolderAlbums> | AlbumFolders,
): AlbumIdentity | null {
  if (folders instanceof AlbumFolders) return folders.identityOf(file);
  if (file.album == null || String(file.album).trim() === "") return null;
  const folder = albumFolder(file.path);
  const known = folders?.get(folder)?.get(file.id);
  if (known && sameFacts(known.file, file)) return known.identity;
  const albums = resolveFolder(db, folder, file);
  folders?.set(folder, albums);
  return albums.get(file.id)?.identity ?? null;
}

/** Which album each of `files` would be on with the facts given, the rest of
 *  each one's album folder as it is: for tags an edit is about to write
 *  (tagwrite/rename.ts). A file without an ALBUM tag is on none. */
export function albumIdentitiesWith(db: Database, files: AlbumFile[]): Map<number, AlbumIdentity> {
  const byFolder = new Map<string, AlbumFile[]>();
  for (const file of files) {
    const folder = albumFolder(file.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }
  const identities = new Map<number, AlbumIdentity>();
  for (const [folder, edited] of byFolder) {
    const ids = new Set(edited.map((file) => file.id));
    const decided = albumIdentities([...readAlbumFolder(db, folder).filter((other) => !ids.has(other.id)), ...edited]);
    for (const file of edited) {
      const identity = decided.get(file.id);
      if (identity) identities.set(file.id, identity);
    }
  }
  return identities;
}
