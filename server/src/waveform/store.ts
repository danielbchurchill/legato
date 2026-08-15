import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

// Sharded by hash prefix, same reasoning as cover/store.ts's cache
// directory — thousands of entries in one flat folder is unkind to both
// the filesystem and anyone browsing it by hand. JSON rather than a
// packed binary format: a peak envelope is a few KB either way at 2000
// buckets, and JSON stays trivially inspectable.
const CACHE_DIR = path.join(DATA_DIR, "waveforms");

export function cachePath(fileHash: string): string {
  return path.join(CACHE_DIR, fileHash.slice(0, 2), `${fileHash}.json`);
}

export async function isCached(fileHash: string): Promise<boolean> {
  try {
    await access(cachePath(fileHash));
    return true;
  } catch {
    return false;
  }
}

export async function readPeaks(fileHash: string): Promise<number[] | null> {
  try {
    const raw = await readFile(cachePath(fileHash), "utf8");
    return JSON.parse(raw) as number[];
  } catch {
    return null;
  }
}

export async function writePeaks(fileHash: string, peaks: number[]): Promise<void> {
  const target = cachePath(fileHash);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(peaks));
}
