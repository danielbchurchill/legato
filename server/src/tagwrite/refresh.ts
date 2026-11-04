import type { Database } from "../sqlite.js";
import { deriveLocalEdges } from "../match/edges.js";
import { recomputeOffThread } from "../recompute.js";
import { finishWrittenFile, readDiskTags, storeWrittenFileTags, type DiskTags } from "../scan/scanner.js";
import { broadcast } from "../ws.js";

/* Issue #464: once a tag write lands, the database has to say what the file
 * now says. The watcher can't do it, on purpose: it recognises Legato's own
 * writes and skips them (tagwrite/guard.ts), which is what keeps a write
 * from setting off another. Before this the panel reloaded to the old
 * values, and they stayed until a full scan.
 *
 * So the route reads each written file back itself before it answers, and
 * the details panel and search see the new values as soon as it does. The
 * files are read from disk first. Then, in one transaction, their new tags
 * are stored, the node the edit renames is carried over (`alongside`,
 * rename.ts), and their edges are derived again. Doing those apart would
 * let a recompute on its worker read a file's new tags beside the node's
 * old name, or the other way round, and file the track under a fresh node
 * of the wrong name. Files whose tags didn't change but whose node was
 * renamed under them (a file the writer had to skip) are derived again in
 * the same transaction, so they land on a node that still has their name.
 *
 * The map's aggregates and positions follow in a recompute, off the request
 * loop, which ends the way the artist-credit pass does
 * (enrich/artistCredit.ts): with the event the canvas refetches on. */

type Read = { fileId: number; filePath: string; libraryRootId: number; tags: DiskTags };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function refreshAfterWrite(
  db: Database,
  writtenFileIds: number[],
  otherFileIds: number[] = [],
  alongside: () => void = () => {},
): Promise<void> {
  const reads: Read[] = [];
  for (const fileId of writtenFileIds) {
    const file = db.prepare("SELECT library_root_id, file_path FROM files WHERE id = ?").get(fileId) as
      | { library_root_id: number; file_path: string }
      | undefined;
    if (!file) continue;
    try {
      reads.push({ fileId, filePath: file.file_path, libraryRootId: file.library_root_id, tags: await readDiskTags(file.file_path) });
    } catch (err) {
      console.warn(`[tag-writes] couldn't read ${file.file_path} back: ${message(err)}`);
    }
  }

  const written = new Set(reads.map((r) => r.fileId));
  db.transaction(() => {
    for (const read of reads) storeWrittenFileTags(db, read.libraryRootId, read.filePath, read.tags);
    alongside();
    for (const read of reads) deriveLocalEdges(db, read.fileId);
    for (const fileId of new Set(otherFileIds)) if (!written.has(fileId)) deriveLocalEdges(db, fileId);
  })();

  for (const read of reads) await finishWrittenFile(db, read.fileId, read.filePath, read.tags.picture);

  if (writtenFileIds.length === 0 && otherFileIds.length === 0) return;
  recomputeOffThread(db)
    .then(() => broadcast("enrich:applied", { kind: "tag_write" }))
    .catch((err: unknown) => console.warn(`[tag-writes] recompute failed: ${message(err)}`));
}

/** The files whose edges point at a node, which a rename of it leaves
 *  behind if they aren't rewritten. */
export function filesLinkedTo(db: Database, nodeId: number | null): number[] {
  if (nodeId == null) return [];
  return (
    db
      .prepare(
        `SELECT DISTINCT f.id FROM edges e JOIN files f ON f.recording_node_id = e.from_node
          WHERE e.to_node = ? AND e.source = 'local' AND f.missing_since IS NULL`,
      )
      .all(nodeId) as { id: number }[]
  ).map((r) => r.id);
}
