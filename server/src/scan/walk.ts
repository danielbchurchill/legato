import path from "node:path";
import fg from "fast-glob";
import { FAST_GLOB_IGNORE } from "./junk.js";

const AUDIO_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".ogg", ".wav", ".ape"]);

export async function walkLibraryRoot(root: string): Promise<string[]> {
  const entries = await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    absolute: true,
    followSymbolicLinks: true,
    suppressErrors: true,
    // Same filesystem-junk exclusions as the chokidar watcher (see
    // scan/watcher.ts) — one shared list in scan/junk.ts so the two can't
    // drift apart (issue #99).
    ignore: FAST_GLOB_IGNORE,
  });
  return entries.filter((p) => AUDIO_EXTENSIONS.has(path.extname(p).toLowerCase()));
}

// Stops at the first audio file rather than walking the whole tree — the
// reachability check (reachability.ts) only needs "is there any music
// here at all", and on a real 100k-file library the answer is one
// directory descent away, not a full walk.
export async function hasAnyAudioFile(root: string): Promise<boolean> {
  const stream = fg.stream("**/*", {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: true,
    suppressErrors: true,
    ignore: FAST_GLOB_IGNORE,
  });
  for await (const entry of stream) {
    if (AUDIO_EXTENSIONS.has(path.extname(String(entry)).toLowerCase())) return true;
  }
  return false;
}

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
