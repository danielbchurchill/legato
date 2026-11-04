import type { Database } from "../sqlite.js";
import { parseTags } from "../scan/tags.js";
import path from "node:path";
import { attachCoverForFile, resolveCover } from "../cover/extract.js";
import { enqueueCoverArtLookupIfNeeded, isEnrichmentEnabled } from "../enrich/queue.js";
import { albumIdentity, stripDiscSuffix, type AlbumIdentity } from "./albumIdentity.js";
import { deriveRecordingEdges, NODE_LOOKUP_SQL } from "./edges.js";
import { mergeNodeInto } from "./people.js";

// Issue #465: brings a library from before album identity forward, once, at
// the first start after migration 0045. Until then an album node was the
// ALBUM tag string, so a set's discs were one node each and two artists'
// same-titled albums shared one. This files every album under the rule
// match/albumIdentity.ts and match/releases.ts follow from now on, keeping
// the nodes a library already has wherever it can:
//
// - The parts of one album become one node. The oldest part (lowest id) is
//   kept and the rest are merged into it with mergeNodeInto, which carries a
//   favourite, a dragged map position, a chosen cover and manual connections
//   from any part. The kept node loses its disc suffix ("[CD1]").
// - A node two or more albums shared stays with the album that has the most
//   of its files, ties going to the album whose first file was added first.
//   Everything on the node stays with that album: favourite, position,
//   chosen cover, connections, MusicBrainz id and description. Each other
//   album starts on a new node with its title, dated from when its files
//   were first seen, and nothing else, apart from art its own files
//   supplied: a cover read from one of its files moves with it, and one
//   that's missing is read from its files again after the start
//   (attachUpgradedCovers). The map places it on the recompute index.ts
//   starts afterwards.
//
// Albums are worked out exactly as match/releases.ts would file the same
// files in id order, and keyed to match, so the next derive of any of them
// lands where this put it.

type UpgradeFile = {
  id: number;
  recordingNodeId: number;
  discNo: number | null;
  firstSeenAt: string;
  identity: AlbumIdentity;
  /** The node the file's ALBUM tag found before: the old rule. */
  oldNodeId: number | null;
};

type Album = {
  title: string;
  hasArtistKey: boolean;
  keys: string[];
  files: UpgradeFile[];
  nodeId: number | null;
};

export type ReleaseUpgradeResult = {
  albums: number;
  merged: number;
  split: number;
  retitled: number;
  discNumbers: number;
  /** Nodes left without art their own files supplied, to be read again. */
  needCovers: number[];
};

// The same choice findRelease makes, against albums still being collected.
function findAlbum(keys: Map<string, Album>, identity: AlbumIdentity): Album | null {
  if (identity.artistKey) {
    const byArtist = keys.get(identity.artistKey);
    if (byArtist) return byArtist;
    const byFolder = keys.get(identity.folderKey);
    return byFolder && !byFolder.hasArtistKey ? byFolder : null;
  }
  return keys.get(identity.folderKey) ?? null;
}

function addKey(keys: Map<string, Album>, key: string, album: Album, isArtistKey: boolean): void {
  if (keys.has(key)) return;
  keys.set(key, album);
  album.keys.push(key);
  if (isArtistKey) album.hasArtistKey = true;
}

function readFiles(db: Database): UpgradeFile[] {
  const rows = db
    .prepare(
      `SELECT id, recording_node_id AS recordingNodeId, file_path AS filePath, tags_raw AS tagsRaw, disc_no AS discNo,
              first_seen_at AS firstSeenAt
         FROM files WHERE missing_since IS NULL AND tags_raw IS NOT NULL ORDER BY id`,
    )
    .all() as {
    id: number;
    recordingNodeId: number;
    filePath: string;
    tagsRaw: string;
    discNo: number | null;
    firstSeenAt: string;
  }[];
  const oldLookup = db.prepare(NODE_LOOKUP_SQL);
  const oldNodes = new Map<string, number | null>();
  const files: UpgradeFile[] = [];
  for (const row of rows) {
    let tags: { album?: string | null; albumartist?: string | null };
    try {
      tags = JSON.parse(row.tagsRaw) as typeof tags;
    } catch {
      continue;
    }
    const identity = albumIdentity(tags, row.filePath);
    if (!identity) continue;
    const album = tags.album!;
    let oldNodeId = oldNodes.get(album);
    if (oldNodeId === undefined) {
      oldNodeId = (oldLookup.get("release", album) as { id: number } | undefined)?.id ?? null;
      oldNodes.set(album, oldNodeId);
    }
    files.push({
      id: row.id,
      recordingNodeId: row.recordingNodeId,
      discNo: row.discNo,
      firstSeenAt: row.firstSeenAt,
      identity,
      oldNodeId,
    });
  }
  return files;
}

function groupAlbums(files: UpgradeFile[]): Album[] {
  const keys = new Map<string, Album>();
  const albums: Album[] = [];
  for (const file of files) {
    let album = findAlbum(keys, file.identity);
    if (!album) {
      album = { title: file.identity.title, hasArtistKey: false, keys: [], files: [], nodeId: null };
      albums.push(album);
    }
    if (file.identity.artistKey) addKey(keys, file.identity.artistKey, album, true);
    addKey(keys, file.identity.folderKey, album, false);
    album.files.push(file);
  }
  return albums;
}

/** The album that keeps each old node: the one with the most of its files,
 *  ties to the one whose first file on it came first. Files are in id
 *  order, so the first album to reach a count holds it on a tie. */
function keepers(albums: Album[]): Map<number, Album> {
  const counts = new Map<number, Map<Album, number>>();
  const firstFile = new Map<number, Map<Album, number>>();
  for (const album of albums) {
    for (const file of album.files) {
      if (file.oldNodeId === null) continue;
      const byAlbum = counts.get(file.oldNodeId) ?? new Map<Album, number>();
      counts.set(file.oldNodeId, byAlbum);
      byAlbum.set(album, (byAlbum.get(album) ?? 0) + 1);
      const firsts = firstFile.get(file.oldNodeId) ?? new Map<Album, number>();
      firstFile.set(file.oldNodeId, firsts);
      if (!firsts.has(album)) firsts.set(album, file.id);
    }
  }
  const keeper = new Map<number, Album>();
  for (const [nodeId, byAlbum] of counts) {
    const firsts = firstFile.get(nodeId)!;
    let best: Album | null = null;
    for (const [album, count] of byAlbum) {
      if (
        best === null ||
        count > byAlbum.get(best)! ||
        (count === byAlbum.get(best)! && firsts.get(album)! < firsts.get(best)!)
      ) {
        best = album;
      }
    }
    keeper.set(nodeId, best!);
  }
  return keeper;
}

/** Runs the upgrade if migration 0045 left it owed, and returns what it did,
 *  or null when there was nothing owed. One transaction: a start that dies
 *  partway leaves it owed, and the next start does it again from the top. */
export function upgradeReleaseIdentities(db: Database): ReleaseUpgradeResult | null {
  if (!db.prepare("SELECT 1 FROM release_identity_upgrade WHERE id = 1").get()) return null;

  return db.transaction(() => {
    const files = readFiles(db);
    const albums = groupAlbums(files);
    const keeper = keepers(albums);
    const result: ReleaseUpgradeResult = {
      albums: albums.length,
      merged: 0,
      split: 0,
      retitled: 0,
      discNumbers: 0,
      needCovers: [],
    };

    // Each album's node: the oldest it keeps, with the rest of what it keeps
    // merged in, or a new one.
    const kept = new Map<Album, number[]>();
    for (const [nodeId, album] of keeper) kept.set(album, [...(kept.get(album) ?? []), nodeId]);
    // Dated from when its files were first seen, not today: the Library's
    // "date added" for an album is its node's (routes/library.ts).
    const insertNode = db.prepare("INSERT INTO nodes (type, title, created_at) VALUES ('release', ?, ?) RETURNING id");
    const mergedInto = new Map<number, number>();
    const splitFrom = new Map<Album, number[]>();
    for (const album of albums) {
      const own = (kept.get(album) ?? []).sort((a, b) => a - b);
      if (own.length > 0) {
        album.nodeId = own[0]!;
        for (const other of own.slice(1)) {
          mergeNodeInto(db, other, album.nodeId);
          mergedInto.set(other, album.nodeId);
          result.merged++;
        }
      } else {
        const added = album.files.map((f) => f.firstSeenAt).sort()[0]!;
        album.nodeId = (insertNode.get(album.title, added) as { id: number }).id;
      }
      // The old nodes this album's files were on but another album kept.
      const lost = [
        ...new Set(
          album.files.map((f) => f.oldNodeId).filter((id): id is number => id !== null && keeper.get(id) !== album),
        ),
      ];
      if (lost.length > 0) {
        splitFrom.set(album, lost);
        result.split++;
      }
    }

    const readTitle = db.prepare("SELECT title FROM nodes WHERE id = ?");
    const retitle = db.prepare("UPDATE nodes SET title = ?, updated_at = datetime('now') WHERE id = ?");
    const insertKey = db.prepare("INSERT OR IGNORE INTO release_keys (key, node_id) VALUES (?, ?)");
    for (const album of albums) {
      const current = (readTitle.get(album.nodeId!) as { title: string }).title;
      const title = keptTitle(current, album.title);
      if (title !== current) {
        retitle.run(title, album.nodeId!);
        result.retitled++;
      }
      for (const key of album.keys) insertKey.run(key, album.nodeId!);
    }

    // A file without a disc tag takes its disc from the suffix, as a scan
    // now does (scan/tags.ts), in the column tracks sort by and in tags_raw,
    // which enrichment's track assignment reads.
    const setDisc = db.prepare(
      "UPDATE files SET disc_no = ?, tags_raw = json_set(tags_raw, '$.discNo', ?) WHERE id = ?",
    );
    for (const file of files) {
      if (file.discNo === null && file.identity.disc !== null) {
        setDisc.run(file.identity.disc, file.identity.disc, file.id);
        result.discNumbers++;
      }
    }

    // The files that leave a node another album kept follow their keys to
    // their own album. Re-deriving the recording, every file of it in id
    // order, is what recompute does, so the edges end up as the next one
    // would leave them.
    const moveCover = db.prepare(
      `UPDATE OR IGNORE cover_art SET node_id = ?, updated_at = datetime('now')
        WHERE node_id = ? AND source IN ('embedded', 'folder') AND origin_file_id = ?`,
    );
    const dropCover = db.prepare(
      "DELETE FROM cover_art WHERE node_id = ? AND source IN ('embedded', 'folder') AND origin_file_id = ?",
    );
    const hasOwnArt = db.prepare("SELECT 1 FROM cover_art WHERE node_id = ? AND source IN ('embedded', 'folder')");
    const rederive = new Set<number>();
    // A lost node may since have been merged into its keeper's other part.
    const current = (nodeId: number): number => mergedInto.get(nodeId) ?? nodeId;
    for (const [album, lost] of splitFrom) {
      for (const file of album.files) {
        if (file.oldNodeId === null || !lost.includes(file.oldNodeId)) continue;
        rederive.add(file.recordingNodeId);
        // Art read from this album's own file, which the shared node had
        // only because this file was scanned last, comes with it, or goes
        // if this album has art of that kind already. Either way the node
        // left behind stops showing it.
        moveCover.run(album.nodeId!, current(file.oldNodeId), file.id);
        dropCover.run(current(file.oldNodeId), file.id);
      }
    }
    for (const recordingNodeId of rederive) deriveRecordingEdges(db, recordingNodeId);

    const needCovers = new Set<number>();
    for (const [album, lost] of splitFrom) {
      needCovers.add(album.nodeId!);
      for (const nodeId of lost) needCovers.add(current(nodeId));
    }
    result.needCovers = [...needCovers].filter((nodeId) => !hasOwnArt.get(nodeId)).sort((a, b) => a - b);

    db.prepare("DELETE FROM release_identity_upgrade").run();
    return result;
  })();
}

// The kept node's own title without its disc suffix, which keeps the casing
// the album has been shown with. A node made new for this album has its
// title already.
function keptTitle(current: string, albumTitle: string): string {
  const own = stripDiscSuffix(current).title;
  return own.toLowerCase() === albumTitle.toLowerCase() ? own : albumTitle;
}

export type UpgradedCovers = { read: number; queued: number; failed: number; firstError: string | null };

/** Reads art for the albums the upgrade left without any of their own, as a
 *  scan would have: the embedded picture, then a cover image in the folder,
 *  from one file in each of the album's folders until one has some. An
 *  album still without any art then gets a Cover Art Archive lookup, as an
 *  art-less album does when its tracks match MusicBrainz (enrich/worker.ts's
 *  applyMatch), unless enrichment is turned off; it asks nothing unless a
 *  track has a MusicBrainz id. Never
 *  throws: a file that can't be read (a drive that's away) is counted, and
 *  the album keeps what it has until the next scan. */
export async function attachUpgradedCovers(db: Database, nodeIds: number[]): Promise<UpgradedCovers> {
  const result: UpgradedCovers = { read: 0, queued: 0, failed: 0, firstError: null };
  for (const nodeId of nodeIds) {
    const files = db
      .prepare(
        `SELECT f.id, f.file_path AS path, f.recording_node_id AS recordingNodeId
           FROM files f JOIN edges e ON e.from_node = f.recording_node_id
          WHERE e.to_node = ? AND e.type = 'appears_on' AND f.missing_since IS NULL
          ORDER BY f.id`,
      )
      .all(nodeId) as { id: number; path: string; recordingNodeId: number }[];
    const folders = new Set<string>();
    for (const file of files) {
      const folder = path.dirname(file.path);
      if (folders.has(folder)) continue;
      folders.add(folder);
      try {
        const { picture } = await parseTags(file.path);
        if (await attachCoverForFile(db, file, picture)) {
          result.read++;
          break;
        }
      } catch (err) {
        result.failed++;
        result.firstError ??= `${file.path}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    if (!resolveCover(db, nodeId) && isEnrichmentEnabled(db)) {
      enqueueCoverArtLookupIfNeeded(db, nodeId);
      result.queued++;
    }
  }
  return result;
}
