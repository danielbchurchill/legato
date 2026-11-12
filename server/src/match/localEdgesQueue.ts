import type { Database } from "../sqlite.js";
import { writeInChunks } from "../writeInChunks.js";
import { albumFolder } from "./albumIdentity.js";
import { deriveLocalEdges } from "./edges.js";
import { LOCAL_EDGE_RULES_HASH } from "./localEdgeRules.js";
import { ALBUM_FOLDER_SQL, AlbumFolders, albumFolderParams } from "./releases.js";

// Issue #323: recompute()'s local edges, derived for the files whose inputs
// changed rather than for every file on every run. Migration 0057's
// triggers queue the path of each file a change can move the edges of (its
// own row, its recording's MusicBrainz evidence, the artist nodes its names
// find), and this derives every present file in each queued path's album
// folder: the album rule (match/albumIdentity.ts) decides over the whole
// folder, so a file's arrival, departure or new tags can move its
// neighbours' album too. When the rules themselves have changed since every
// file was last derived (match/localEdgeRules.ts), it derives every file.

type Pending = { id: number; path: string };

function storedRules(db: Database): string | null {
  return (db.prepare("SELECT hash FROM local_edges_rules WHERE id = 1").get() as { hash: string | null } | undefined)?.hash ?? null;
}

/** Whether every file is owed a derive by this build's rules: true on the
 *  first start after migration 0057, and after any build whose rules differ
 *  from the ones every file was last derived by. */
export function localEdgeRulesChanged(db: Database): boolean {
  return storedRules(db) !== LOCAL_EDGE_RULES_HASH;
}

// Every present file whose album folder is one of those given, in id order,
// the order a full pass derives them in.
function filesInAlbumFolders(db: Database, folders: Set<string>): number[] {
  const statement = db.prepare(ALBUM_FOLDER_SQL);
  const ids = new Set<number>();
  for (const folder of folders) {
    for (const row of statement.all(...albumFolderParams(folder)) as { id: number; path: string }[]) {
      if (albumFolder(row.path) === folder) ids.add(row.id);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

export type DerivedLocalEdges = { files: number; everyFile: boolean };

/** Derives the local edges of every file the queue asks for, or of every
 *  file when the rules have changed. Writes nothing when neither is owed. */
export function deriveChangedLocalEdges(db: Database): DerivedLocalEdges {
  // The queue is read first: a change committed after this queues its path
  // again, with a larger id, and the next run derives it.
  const pending = db.prepare("SELECT id, file_path AS path FROM local_edges_pending ORDER BY id").all() as Pending[];
  const everyFile = localEdgeRulesChanged(db);
  if (pending.length === 0 && !everyFile) return { files: 0, everyFile };

  const files = everyFile
    ? (db.prepare("SELECT id FROM files WHERE missing_since IS NULL ORDER BY id").all() as { id: number }[]).map((r) => r.id)
    : filesInAlbumFolders(db, new Set(pending.map((p) => albumFolder(p.path))));

  // Each file is its own transaction (match/edges.ts); a piece of them
  // commits together, rather than every statement on its own. Issue #465:
  // each album folder is read once for the whole pass.
  const albums = new AlbumFolders(db);
  writeInChunks(db, files, (id) => deriveLocalEdges(db, id, albums));

  // Only once every file above has committed: a run that stops partway
  // leaves the queue, and the stored rules, for the next one to finish.
  const read = pending.length > 0 ? pending[pending.length - 1]!.id : 0;
  db.transaction(() => {
    if (read > 0) db.prepare("DELETE FROM local_edges_pending WHERE id <= ?").run(read);
    if (everyFile) db.prepare("UPDATE local_edges_rules SET hash = ? WHERE id = 1").run(LOCAL_EDGE_RULES_HASH);
  })();
  return { files: files.length, everyFile };
}
