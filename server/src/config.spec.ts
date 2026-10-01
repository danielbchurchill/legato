import { describe, expect, it } from "bun:test";
import { resolveLegatoIdOrigin, resolveMediaConcurrencyLimit } from "./config.js";

describe("resolveMediaConcurrencyLimit", () => {
  it("defaults to max(1, cores - 1) when LEGATO_MEDIA_CONCURRENCY is unset", () => {
    expect(resolveMediaConcurrencyLimit({}, 4)).toBe(3);
    expect(resolveMediaConcurrencyLimit({}, 8)).toBe(7);
  });

  // Issue #111's actual reason to exist: a single-core host must still get
  // a working (if fully serial) queue rather than a limit of 0, which
  // would leave every media task waiting forever.
  it("never goes below 1, even on a single-core host", () => {
    expect(resolveMediaConcurrencyLimit({}, 1)).toBe(1);
  });

  it("uses LEGATO_MEDIA_CONCURRENCY when it's a valid positive integer", () => {
    expect(resolveMediaConcurrencyLimit({ LEGATO_MEDIA_CONCURRENCY: "2" }, 8)).toBe(2);
    expect(resolveMediaConcurrencyLimit({ LEGATO_MEDIA_CONCURRENCY: "1" }, 8)).toBe(1);
  });

  it("falls back to the cores-based default for a non-numeric value", () => {
    expect(resolveMediaConcurrencyLimit({ LEGATO_MEDIA_CONCURRENCY: "lots" }, 4)).toBe(3);
  });

  it("falls back to the cores-based default for zero or negative values", () => {
    expect(resolveMediaConcurrencyLimit({ LEGATO_MEDIA_CONCURRENCY: "0" }, 4)).toBe(3);
    expect(resolveMediaConcurrencyLimit({ LEGATO_MEDIA_CONCURRENCY: "-1" }, 4)).toBe(3);
  });

  it("falls back to the cores-based default for a non-integer value", () => {
    expect(resolveMediaConcurrencyLimit({ LEGATO_MEDIA_CONCURRENCY: "2.5" }, 4)).toBe(3);
  });
});

describe("resolveLegatoIdOrigin", () => {
  it("defaults to auth.legato.fm", () => {
    expect(resolveLegatoIdOrigin({})).toBe("https://auth.legato.fm");
    expect(resolveLegatoIdOrigin({ LEGATO_ID_ORIGIN: "  " })).toBe("https://auth.legato.fm");
  });

  it("turns off with `off`", () => {
    expect(resolveLegatoIdOrigin({ LEGATO_ID_ORIGIN: "off" })).toBeNull();
    expect(resolveLegatoIdOrigin({ LEGATO_ID_ORIGIN: "OFF" })).toBeNull();
  });

  it("accepts a bare origin, with or without a trailing slash", () => {
    expect(resolveLegatoIdOrigin({ LEGATO_ID_ORIGIN: "http://127.0.0.1:8901" })).toBe("http://127.0.0.1:8901");
    expect(resolveLegatoIdOrigin({ LEGATO_ID_ORIGIN: "https://auth.example.com/" })).toBe("https://auth.example.com");
  });

  it("refuses a path, another scheme, or garbage", () => {
    expect(() => resolveLegatoIdOrigin({ LEGATO_ID_ORIGIN: "https://auth.legato.fm/api" })).toThrow(/just an origin/);
    expect(() => resolveLegatoIdOrigin({ LEGATO_ID_ORIGIN: "ftp://auth.legato.fm" })).toThrow(/just an origin/);
    expect(() => resolveLegatoIdOrigin({ LEGATO_ID_ORIGIN: "not a url" })).toThrow(/LEGATO_ID_ORIGIN/);
  });
});
