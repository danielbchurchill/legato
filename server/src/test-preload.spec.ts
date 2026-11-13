import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { PICTURES_DIR } from "./account/pictures.js";
import { DATA_DIR } from "./config.js";
import { CACHE_DIR as COVERS_DIR } from "./cover/store.js";
import { CACHE_DIR as STREAMS_DIR } from "./stream/cache.js";
import { cachePath as waveformPath } from "./waveform/store.js";

// Issue #506: test-preload.ts gives each spec file a throwaway data dir, so
// nothing the server caches under DATA_DIR reaches a contributor's real one.
// check.yml backs this with a run under an empty HOME.

const defaultDataDir = path.join(homedir(), ".local", "share", "legato");

function inside(dir: string, parent: string): boolean {
  const relative = path.relative(parent, dir);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

describe("the suite's data dir", () => {
  it("is a temporary directory, not the default one", () => {
    expect(inside(DATA_DIR, tmpdir())).toBe(true);
    expect(path.basename(DATA_DIR)).toStartWith("legato-test-data-");
    expect(existsSync(DATA_DIR)).toBe(true);
    expect(DATA_DIR === defaultDataDir || inside(DATA_DIR, defaultDataDir)).toBe(false);
  });

  it("holds the waveform, cover, stream and picture caches", () => {
    for (const dir of [path.dirname(path.dirname(waveformPath("ab".repeat(20)))), COVERS_DIR, STREAMS_DIR, PICTURES_DIR]) {
      expect(inside(dir, DATA_DIR)).toBe(true);
    }
  });
});
