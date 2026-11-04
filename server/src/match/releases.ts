import type { Database } from "../sqlite.js";
import type { AlbumIdentity } from "./albumIdentity.js";

// Issue #465: the album node a file's appears_on edge points at. Which album
// a file is on is match/albumIdentity.ts's to say; this finds that album's
// node through release_keys (migration 0045), or makes it.
//
// Each album node is reached by up to two kinds of key. Its artist key
// (title + ALBUMARTIST) belongs to it alone. Its folder key (title + album
// folder) is how a file with no ALBUMARTIST finds it: the first album of
// that title in that folder holds it, and a later one in the same folder,
// which only a second ALBUMARTIST can tell apart, doesn't take it over.
//
// - A file with an ALBUMARTIST goes to the node its artist key names. With
//   no such node yet, it goes to the node its folder key names, as long as
//   no ALBUMARTIST has claimed that one: an album whose files had no
//   ALBUMARTIST, or only some of them did, keeps its node when the tag
//   arrives. Otherwise it's a new album.
// - A file without one goes to the node its folder key names, or a new one.
//
// So two artists' same-titled albums are two nodes wherever they are, a
// compilation without ALBUMARTIST in one folder is one node, and so is an
// album where only some tracks have the tag. Neither order of deriving the
// files changes the answer.

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
