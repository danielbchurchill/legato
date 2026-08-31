import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export type OrphanFile = { path: string; bytes: number };

export type SweepReport = {
  liveHashCount: number;
  orphans: OrphanFile[];
  orphanBytes: number;
  // Populated only when dryRun is false — the subset of `orphans` actually
  // removed. Equal to `orphans` on success; unlink failures throw rather
  // than partially report, so a caller never sees a mismatched count.
  deleted: OrphanFile[];
};

// Recursively lists every regular file under `root`, however deep. The two
// callers of sweepCache() below have different shapes on disk — cover art
// nests a size-ladder directory between the cache root and the hash-prefix
// shards, the stream cache doesn't — and walking arbitrarily deep means
// neither caller has to describe its own layout here, which is also what
// makes an unknown/stale size directory (an old rung of cover art's ladder)
// fall out of the sweep for free rather than needing special-casing.
//
// A cache directory that has never been written to (fresh install, or the
// stream cache before the first transcode) reports zero files instead of
// throwing.
async function walkFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

// One sweep pass over a content-addressed cache directory: any file on disk
// whose hash — as `parseHash` reads it back out of the path — isn't in
// `liveHashes` is an orphan. `parseHash` returning null means "not a cache
// blob at all" (a stray `<hash>.jpg.<uuid>.tmp` left by an interrupted
// write in store.ts/cache.ts, a `.DS_Store`, anything unrecognized) — left
// alone either way, same as a live hash. This sweep's contract is narrowly
// "remove known-shape blobs nothing references any more," not general
// cache-directory cleanup.
//
// Report-first, matching this project's stated caution around destructive
// maintenance operations (tagwrite's mandatory diff before any write):
// dryRun defaults to true, and the orphan list itself is identical in both
// modes — only whether unlink() actually runs differs.
export async function sweepCache(
  cacheDir: string,
  liveHashes: ReadonlySet<string>,
  parseHash: (filePath: string) => string | null,
  dryRun = true,
): Promise<SweepReport> {
  const files = await walkFiles(cacheDir);

  const orphans: OrphanFile[] = [];
  for (const filePath of files) {
    const hash = parseHash(filePath);
    if (hash === null || liveHashes.has(hash)) continue;
    const { size } = await stat(filePath);
    orphans.push({ path: filePath, bytes: size });
  }

  const deleted: OrphanFile[] = [];
  if (!dryRun) {
    for (const orphan of orphans) {
      await unlink(orphan.path);
      deleted.push(orphan);
    }
  }

  return {
    liveHashCount: liveHashes.size,
    orphans,
    orphanBytes: orphans.reduce((sum, o) => sum + o.bytes, 0),
    deleted,
  };
}
