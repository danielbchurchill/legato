import { stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import { readWriteMarker } from "./writer.js";

// Distinguishes "this chokidar change event is our own write settling"
// from a real external edit — the concrete fix for the self-triggering-
// rewrite-loop bug found in a direct competitor (Musicat): write tags ->
// watcher sees the write as an external change -> re-decides a fix is
// needed -> writes again, forever. Both the on-disk write-id (a custom
// Vorbis comment field, see writer.ts) and the mtime have to match what
// we stamped — either alone could coincidentally match.
export async function isSelfWrite(db: Database.Database, filePath: string): Promise<boolean> {
  const row = db
    .prepare("SELECT app_write_marker, last_written_mtime FROM files WHERE file_path = ?")
    .get(filePath) as { app_write_marker: string | null; last_written_mtime: string | null } | undefined;

  if (!row?.app_write_marker || !row.last_written_mtime) return false;

  const stats = await stat(filePath).catch(() => null);
  if (!stats || stats.mtime.toISOString() !== row.last_written_mtime) return false;

  try {
    return readWriteMarker(filePath) === row.app_write_marker;
  } catch {
    // Malformed/unreadable tag block — treat as not-a-self-write and let
    // the normal scan path handle (or fail on) it instead of crashing here.
    return false;
  }
}
