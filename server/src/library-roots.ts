import type Database from "better-sqlite3";

export type LibraryRootContents = { files: number; plays: number; tagWrites: number };

// Split out from routes/library-roots.ts so the cascade is testable against
// a real schema without standing up an HTTP server — the same shape as
// hygiene.ts to routes/hygiene.ts.

/** What removing this root would destroy. plays is the number that matters:
 *  a re-scan rebuilds files, nodes and edges from disk, but nothing brings
 *  listening history back. */
export function countLibraryRootContents(db: Database.Database, id: number): LibraryRootContents {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM files WHERE library_root_id = ?) AS files,
         (SELECT COUNT(*) FROM plays WHERE file_id IN (SELECT id FROM files WHERE library_root_id = ?)) AS plays,
         (SELECT COUNT(*) FROM tag_writes WHERE file_id IN (SELECT id FROM files WHERE library_root_id = ?)) AS tagWrites`,
    )
    .get(id, id, id) as LibraryRootContents;
}

// Deletes in foreign-key order, innermost first. Every one of these is a
// NOT NULL reference with no cascade declared, which is why the original
// single-statement delete could never run: scan_jobs alone guaranteed a
// constraint failure for any root that had ever been scanned, and adding a
// root scans it immediately. cover_art is the exception and needs no line
// here — its origin_file_id is ON DELETE SET NULL, so cached art outlives
// the file it was extracted from and stays addressable by content hash.
//
// One transaction: a half-removed root leaves files pointing at a library
// root that no longer exists, which no later scan would ever reconcile.
export function removeLibraryRootCascade(db: Database.Database, id: number): void {
  const scopedFiles = "SELECT id FROM files WHERE library_root_id = ?";
  const remove = db.transaction(() => {
    db.prepare(`DELETE FROM plays WHERE file_id IN (${scopedFiles})`).run(id);
    db.prepare(`DELETE FROM tag_writes WHERE file_id IN (${scopedFiles})`).run(id);
    db.prepare(`DELETE FROM merge_overrides WHERE file_id IN (${scopedFiles})`).run(id);
    db.prepare("DELETE FROM files WHERE library_root_id = ?").run(id);
    db.prepare("DELETE FROM scan_jobs WHERE library_root_id = ?").run(id);
    db.prepare("DELETE FROM library_roots WHERE id = ?").run(id);
  });
  remove();
}
