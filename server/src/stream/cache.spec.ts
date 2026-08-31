import path from "node:path";
import { describe, expect, it } from "vitest";
import { cachePath } from "./cache.js";

const HASH = "0123456789abcdef0123456789abcdef01234567";

describe("cachePath", () => {
  it("shards by the first two characters of the hash, like cover/waveform caches", () => {
    expect(cachePath(HASH).endsWith(path.join("01", `${HASH}.flac`))).toBe(true);
  });

  it("is deterministic for the same hash", () => {
    expect(cachePath(HASH)).toBe(cachePath(HASH));
  });

  it("gives different hashes different paths", () => {
    const other = "ffffffffffffffffffffffffffffffffffffffff";
    expect(cachePath(HASH)).not.toBe(cachePath(other));
  });
});
