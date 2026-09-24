import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sweepCache } from "./evict.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-evict-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Mirrors the real caches' `.<ext>` naming closely enough to exercise
// sweepCache() without depending on cover/stream's own file layout.
function parseHash(filePath: string): string | null {
  if (path.extname(filePath) !== ".blob") return null;
  return path.basename(filePath, ".blob");
}

function write(relPath: string, contents = "x"): void {
  const full = path.join(dir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

describe("sweepCache", () => {
  it("reports orphans without deleting anything when dryRun (the default)", async () => {
    write("aa/live.blob", "live bytes");
    write("bb/orphan.blob", "orphan bytes");

    const report = await sweepCache(dir, new Set(["live"]), parseHash);

    expect(report.orphans.map((o) => o.path)).toEqual([path.join(dir, "bb/orphan.blob")]);
    expect(report.orphanBytes).toBe("orphan bytes".length);
    expect(report.deleted).toEqual([]);
    expect(existsSync(path.join(dir, "bb/orphan.blob"))).toBe(true); // untouched
  });

  it("deletes only the orphans when dryRun is false, leaving live files alone", async () => {
    write("aa/live.blob", "live");
    write("bb/orphan-1.blob", "orphan 1");
    write("cc/orphan-2.blob", "orphan 2");

    const report = await sweepCache(dir, new Set(["live"]), parseHash, false);

    expect(report.deleted).toHaveLength(2);
    expect(existsSync(path.join(dir, "aa/live.blob"))).toBe(true);
    expect(existsSync(path.join(dir, "bb/orphan-1.blob"))).toBe(false);
    expect(existsSync(path.join(dir, "cc/orphan-2.blob"))).toBe(false);
  });

  it("ignores files parseHash doesn't recognize — e.g. a stray .tmp from an interrupted write", async () => {
    write("aa/orphan.blob.deadbeef.tmp", "mid-write");

    const report = await sweepCache(dir, new Set(), parseHash, false);

    expect(report.orphans).toEqual([]);
    expect(existsSync(path.join(dir, "aa/orphan.blob.deadbeef.tmp"))).toBe(true);
  });

  it("reports zero orphans for a cache directory that doesn't exist yet, without crashing", async () => {
    const report = await sweepCache(path.join(dir, "never-created"), new Set(["anything"]), parseHash);

    expect(report.orphans).toEqual([]);
    expect(report.orphanBytes).toBe(0);
    expect(report.liveHashCount).toBe(1);
  });

  it("reports zero orphans for an empty cache directory", async () => {
    const report = await sweepCache(dir, new Set(), parseHash);
    expect(report.orphans).toEqual([]);
  });
});
