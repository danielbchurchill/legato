import { randomUUID } from "node:crypto";
import { copyFile, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { File as TagLibFile } from "node-taglib-sharp";
import { detectFormat, getWriteMarker, setWriteMarker, writeFields, type TagFields } from "./fields.js";

export type WriteResult = { writeId: string; writtenMtime: string };

// Never touches the original file until the very last step. The whole
// point of temp -> fsync -> rename is that a crash at any point before the
// rename leaves the original completely untouched — a real requirement,
// not a nicety, per Legato.md's write-back spec ("the only operation that
// can destroy user data"). node-taglib-sharp's own FLAC writer already
// patches in place with reserved padding rather than rewriting whole-file
// (confirmed by reading its source — see flacFile.js's save()); this
// wrapper adds the crash-safety property on top, since that's not
// something to assume any library provides without checking.
async function atomicWrite(filePath: string, mutate: (file: TagLibFile) => void): Promise<string> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.legato-write-${randomUUID()}${path.extname(filePath)}`);

  await copyFile(filePath, tempPath);

  try {
    const file = TagLibFile.createFromPath(tempPath);
    try {
      mutate(file);
      file.save();
    } finally {
      file.dispose();
    }

    const handle = await open(tempPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, filePath); // atomic on the same filesystem
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }

  const stats = await stat(filePath);
  return stats.mtime.toISOString();
}

export async function applyTagWrite(filePath: string, changes: TagFields): Promise<WriteResult> {
  const format = detectFormat(filePath);
  const writeId = randomUUID();

  const writtenMtime = await atomicWrite(filePath, (file) => {
    writeFields(file.tag, changes, format);
    setWriteMarker(file.tag, format, writeId);
  });

  return { writeId, writtenMtime };
}

export async function revertTagWrite(
  filePath: string,
  oldValues: TagFields,
): Promise<WriteResult> {
  const format = detectFormat(filePath);
  const writeId = randomUUID();

  const writtenMtime = await atomicWrite(filePath, (file) => {
    writeFields(file.tag, oldValues, format);
    setWriteMarker(file.tag, format, writeId);
  });

  return { writeId, writtenMtime };
}

// Read back the marker actually on disk right now — used by the watcher
// guard to tell "this change event is our own write settling" apart from
// "someone/something else touched this file."
export function readWriteMarker(filePath: string): string | null {
  const format = detectFormat(filePath);
  const file = TagLibFile.createFromPath(filePath);
  try {
    return getWriteMarker(file.tag, format);
  } finally {
    file.dispose();
  }
}
