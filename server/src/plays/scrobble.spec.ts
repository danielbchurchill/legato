import { describe, expect, it } from "bun:test";
import { shouldScrobble } from "./scrobble.js";

describe("shouldScrobble", () => {
  it("counts a play at 50% of a short track, well under 4 minutes", () => {
    const durationMs = 3 * 60 * 1000; // 3 min — 50% is 90s, under the 4min floor
    expect(shouldScrobble(90 * 1000, durationMs)).toBe(true);
    expect(shouldScrobble(89 * 1000, durationMs)).toBe(false);
  });

  it("counts a play at the 4-minute floor for a long track, before 50% is reached", () => {
    const durationMs = 20 * 60 * 1000; // 20 min — 50% is 10min, the 4min floor hits first
    expect(shouldScrobble(4 * 60 * 1000, durationMs)).toBe(true);
    expect(shouldScrobble(4 * 60 * 1000 - 1, durationMs)).toBe(false);
  });

  it("falls back to the 4-minute floor alone when duration is unknown", () => {
    expect(shouldScrobble(4 * 60 * 1000, null)).toBe(true);
    expect(shouldScrobble(3 * 60 * 1000, null)).toBe(false);
  });

  it("rejects zero or negative listening time", () => {
    expect(shouldScrobble(0, 200000)).toBe(false);
    expect(shouldScrobble(-100, 200000)).toBe(false);
  });
});
