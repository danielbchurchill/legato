// Issue #98: a packaged build has no guarantee ffmpeg/fpcalc are on PATH —
// only the binaries mediaBinaries.ts resolves (FFMPEG_PATH / FPCALC_PATH,
// which fall back to the bare command name for dev-machine PATH resolution
// when the LEGATO_FFMPEG_PATH / LEGATO_FPCALC_PATH env vars are unset) are
// guaranteed to exist. Spawning ffmpeg by its bare command name bypasses
// that and only "works" by accident, on a machine that happens to have it
// installed.
//
// This greps every source file in server/src for that mistake so it can't
// come back silently — see server/src/index.ts:179 for the bug this closes.
import { readFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { describe, expect, it } from "vitest";

const BARE_SPAWN_PATTERN = /\bspawn(?:Sync)?\(\s*["'](?:ffmpeg|fpcalc)["']/;

describe("bare ffmpeg/fpcalc spawn guard", () => {
  it("never spawns ffmpeg or fpcalc by bare command name", async () => {
    const srcDir = path.join(import.meta.dirname, ".");
    const files = await fg("**/*.ts", {
      cwd: srcDir,
      ignore: ["**/*.spec.ts"],
      absolute: true,
    });

    const offenders = files.filter((file) => BARE_SPAWN_PATTERN.test(readFileSync(file, "utf8")));

    expect(offenders.map((file) => path.relative(srcDir, file))).toEqual([]);
  });
});
