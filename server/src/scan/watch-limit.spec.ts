import { describe, expect, it } from "bun:test";
import { isNearWatchLimit, isWatchExhaustionError, readMaxUserWatches, watchExhaustionReason } from "./watch-limit.js";

describe("isWatchExhaustionError", () => {
  it("recognizes ENOSPC and EMFILE", () => {
    expect(isWatchExhaustionError(Object.assign(new Error("no space"), { code: "ENOSPC" }))).toBe(true);
    expect(isWatchExhaustionError(Object.assign(new Error("too many open files"), { code: "EMFILE" }))).toBe(true);
  });

  it("rejects unrelated fs errors, so a real broken symlink or a permissions issue never triggers a fallback", () => {
    expect(isWatchExhaustionError(Object.assign(new Error("nope"), { code: "EACCES" }))).toBe(false);
    expect(isWatchExhaustionError(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe(false);
  });

  it("rejects non-error values without throwing", () => {
    expect(isWatchExhaustionError(undefined)).toBe(false);
    expect(isWatchExhaustionError(null)).toBe(false);
    expect(isWatchExhaustionError("ENOSPC")).toBe(false);
    expect(isWatchExhaustionError({})).toBe(false);
  });
});

describe("watchExhaustionReason", () => {
  it("maps EMFILE to 'emfile' and everything else exhaustion-shaped to 'enospc'", () => {
    expect(watchExhaustionReason(Object.assign(new Error(""), { code: "EMFILE" }))).toBe("emfile");
    expect(watchExhaustionReason(Object.assign(new Error(""), { code: "ENOSPC" }))).toBe("enospc");
  });
});

describe("readMaxUserWatches", () => {
  it("parses the integer inside /proc/sys/fs/inotify/max_user_watches", () => {
    expect(readMaxUserWatches(() => "8192\n")).toBe(8192);
  });

  it("returns null when the file can't be read — not on Linux, or /proc isn't mounted", () => {
    expect(
      readMaxUserWatches(() => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  it("returns null for unparseable or non-positive contents rather than a nonsense number", () => {
    expect(readMaxUserWatches(() => "not a number")).toBeNull();
    expect(readMaxUserWatches(() => "0")).toBeNull();
    expect(readMaxUserWatches(() => "-5")).toBeNull();
  });
});

describe("isNearWatchLimit", () => {
  it("is false when the limit is unknown (non-Linux, or unreadable)", () => {
    expect(isNearWatchLimit(1_000_000, null)).toBe(false);
  });

  it("is false comfortably under the limit", () => {
    expect(isNearWatchLimit(100, 8192)).toBe(false);
  });

  it("is true once the watched count closes in on the limit, ahead of actually hitting it", () => {
    // 90% of 8192 is 7372.8 — 7373 crosses it, 7372 doesn't.
    expect(isNearWatchLimit(7372, 8192)).toBe(false);
    expect(isNearWatchLimit(7373, 8192)).toBe(true);
    expect(isNearWatchLimit(8192, 8192)).toBe(true);
  });
});
