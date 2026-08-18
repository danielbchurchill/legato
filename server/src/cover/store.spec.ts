import path from "node:path";
import { describe, expect, it } from "vitest";
import { cachePath, hashBytes } from "./store.js";

const HASH = "0123456789abcdef0123456789abcdef01234567";

describe("hashBytes", () => {
  it("is a sha1 of the original bytes, so identical art shares one cache entry", () => {
    expect(hashBytes(Buffer.from("cover"))).toBe(hashBytes(Buffer.from("cover")));
    expect(hashBytes(Buffer.from("cover"))).not.toBe(hashBytes(Buffer.from("other")));
    expect(hashBytes(Buffer.from("cover"))).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("cachePath", () => {
  // The mechanism that makes changing a derived size a plain cache miss rather
  // than a migration: the directory is named after the pixel bound, so art
  // written under an older ladder can never be mistaken for the new size.
  // If this ever reverts to naming directories after the size *name*, every
  // already-cached cover keeps serving its old resolution forever, because
  // isCached() only asks whether a file exists.
  it("names the size directory after the pixel bound, not the size name", () => {
    expect(cachePath(HASH, "thumb").split(path.sep)).toContain("256");
    expect(cachePath(HASH, "full").split(path.sep)).toContain("512");
    expect(cachePath(HASH, "thumb")).not.toContain("thumb");
  });

  it("shards by the first two characters of the hash", () => {
    expect(cachePath(HASH, "full").endsWith(path.join("01", `${HASH}.jpg`))).toBe(true);
  });

  it("gives the two sizes different paths for the same art", () => {
    expect(cachePath(HASH, "thumb")).not.toBe(cachePath(HASH, "full"));
  });
});
