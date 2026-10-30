import { describe, expect, it } from "bun:test";
import {
  DEFAULT_STREAM_CACHE_MB,
  resolveLegatoIdOrigin,
  resolveMediaConcurrencyLimit,
  resolveServerName,
  resolveStreamCacheBudget,
} from "./config.js";

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

// Issue #117: the name the connect screen and the mDNS advertisement show.
describe("resolveServerName", () => {
  it("is the machine's name, without macOS's .local", () => {
    expect(resolveServerName({}, "musicbox")).toBe("musicbox");
    expect(resolveServerName({}, "Priyas-MacBook.local")).toBe("Priyas-MacBook");
  });

  it("takes LEGATO_SERVER_NAME over the hostname, which in Docker is a random id", () => {
    expect(resolveServerName({ LEGATO_SERVER_NAME: "  Living room  " }, "3f9a1c2b7d4e")).toBe("Living room");
  });

  it("caps the name at one DNS label, and never leaves it empty", () => {
    expect(resolveServerName({ LEGATO_SERVER_NAME: "x".repeat(80) }, "h")).toHaveLength(63);
    expect(resolveServerName({ LEGATO_SERVER_NAME: "   " }, ".local")).toBe("Legato server");
  });
});

describe("resolveStreamCacheBudget", () => {
  const MB = 1024 * 1024;

  // #423: sized for a Raspberry Pi's SD card.
  it("defaults to 4 GB when LEGATO_STREAM_CACHE_MB is unset or empty", () => {
    expect(DEFAULT_STREAM_CACHE_MB).toBe(4096);
    expect(resolveStreamCacheBudget({})).toEqual({ bytes: 4 * 1024 ** 3, warning: null });
    expect(resolveStreamCacheBudget({ LEGATO_STREAM_CACHE_MB: " " })).toEqual({ bytes: 4 * 1024 ** 3, warning: null });
  });

  it("takes LEGATO_STREAM_CACHE_MB in whole megabytes", () => {
    expect(resolveStreamCacheBudget({ LEGATO_STREAM_CACHE_MB: "1024" })).toEqual({ bytes: 1024 * MB, warning: null });
    expect(resolveStreamCacheBudget({ LEGATO_STREAM_CACHE_MB: " 20000 " })).toEqual({ bytes: 20000 * MB, warning: null });
    expect(resolveStreamCacheBudget({ LEGATO_STREAM_CACHE_MB: "1" })).toEqual({ bytes: MB, warning: null });
  });

  // There's no "unlimited": a budget of nothing would empty the cache
  // after every track, and a typo shouldn't mean that.
  it("falls back to the default with a warning for 0 or anything that isn't a whole number", () => {
    for (const value of ["0", "-1", "2.5", "4G", "4096MB", "lots", "1e3", "0x10", "unlimited"]) {
      const { bytes, warning } = resolveStreamCacheBudget({ LEGATO_STREAM_CACHE_MB: value });
      expect(bytes).toBe(4 * 1024 ** 3);
      expect(warning).toContain(`LEGATO_STREAM_CACHE_MB="${value}"`);
      expect(warning).toContain("4096 MB");
    }
  });

  it("refuses a number too big to count bytes in exactly", () => {
    expect(resolveStreamCacheBudget({ LEGATO_STREAM_CACHE_MB: "9".repeat(20) }).warning).not.toBeNull();
  });
});
