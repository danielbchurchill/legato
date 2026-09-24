import { describe, expect, it } from "bun:test";
import { resolveFfmpegPath, resolveFpcalcPath } from "./mediaBinaries.js";

describe("resolveFfmpegPath", () => {
  it("uses LEGATO_FFMPEG_PATH when set", () => {
    expect(resolveFfmpegPath({ LEGATO_FFMPEG_PATH: "/opt/legato/bin/ffmpeg" })).toBe(
      "/opt/legato/bin/ffmpeg",
    );
  });

  it("falls back to the bare command name for PATH resolution when unset", () => {
    expect(resolveFfmpegPath({})).toBe("ffmpeg");
  });
});

describe("resolveFpcalcPath", () => {
  it("uses LEGATO_FPCALC_PATH when set", () => {
    expect(resolveFpcalcPath({ LEGATO_FPCALC_PATH: "/opt/legato/bin/fpcalc" })).toBe(
      "/opt/legato/bin/fpcalc",
    );
  });

  it("falls back to the bare command name for PATH resolution when unset", () => {
    expect(resolveFpcalcPath({})).toBe("fpcalc");
  });
});
