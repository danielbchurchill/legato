import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseFile } from "music-metadata";
import { computeDiff } from "./diff.js";
import { unwritableReason } from "./fields.js";
import { applyTagWrite } from "./writer.js";

// Issue #464's fields, checked the way the rest of the writer's are: written
// through TagLib# and read back through music-metadata, the app's own tag
// reader, so a value written here is what the next scan sees. One real
// ffmpeg-made file per container, copied for each test.
let dir: string;
const templates: Record<string, string> = {};

function ffmpeg(out: string, extra: string[]): void {
  execFileSync(
    "ffmpeg",
    ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-metadata", "artist=JPEGMAFIA; Danny Brown", ...extra, out],
    { stdio: "ignore" },
  );
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-tagwrite-credits-"));
  templates.flac = path.join(dir, "template.flac");
  templates.mp3 = path.join(dir, "template.mp3");
  templates.mp3v23 = path.join(dir, "template-v23.mp3");
  templates.m4a = path.join(dir, "template.m4a");
  ffmpeg(templates.flac, []);
  ffmpeg(templates.mp3, []);
  ffmpeg(templates.mp3v23, ["-id3v2_version", "3"]);
  ffmpeg(templates.m4a, ["-c:a", "aac"]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let copies = 0;
function copyOf(kind: string): string {
  const template = templates[kind]!;
  const target = path.join(dir, `copy-${copies++}${path.extname(template)}`);
  copyFileSync(template, target);
  return target;
}

for (const kind of ["flac", "mp3", "mp3v23", "m4a"]) {
  describe(`issue #464 fields (${kind})`, () => {
    it("writes the album artist music-metadata reads as albumartist", async () => {
      const file = copyOf(kind);
      await applyTagWrite(file, { albumArtist: "Bob Dylan & The Band" });
      expect((await parseFile(file)).common.albumartist).toBe("Bob Dylan & The Band");
      expect(computeDiff(file, { albumArtist: "Bob Dylan & The Band" })).toEqual([]);
    });

    it("writes the ARTISTS list music-metadata reads as artists", async () => {
      const file = copyOf(kind);
      await applyTagWrite(file, { artists: ["JPEGMAFIA", "Danny Brown"] });
      expect((await parseFile(file)).common.artists).toEqual(["JPEGMAFIA", "Danny Brown"]);
      expect(computeDiff(file, { artists: ["JPEGMAFIA", "Danny Brown"] })).toEqual([]);
    });

    it("writes producer and engineer credits, each without disturbing the other", async () => {
      const file = copyOf(kind);
      await applyTagWrite(file, { producer: ["Rick Rubin", "George Martin"], engineer: ["Geoff Emerick"] });
      await applyTagWrite(file, { producer: ["Rick Rubin"] });
      const { common } = await parseFile(file);
      expect(common.producer).toEqual(["Rick Rubin"]);
      expect(common.engineer).toEqual(["Geoff Emerick"]);
      expect(computeDiff(file, { producer: ["Rick Rubin"], engineer: ["Geoff Emerick"] })).toEqual([]);
    });

    it("rewrites the artist line whole, which the scanner then reads as the artist", async () => {
      const file = copyOf(kind);
      await applyTagWrite(file, { artist: "JPEGMAFIA; Danny B." });
      expect((await parseFile(file)).common.artist).toBe("JPEGMAFIA; Danny B.");
    });
  });
}

describe("issue #464 artist values", () => {
  it("keeps a file's second ARTIST value when the first is rewritten", async () => {
    const file = copyOf("flac");
    await applyTagWrite(file, { performers: ["JPEGMAFIA", "Danny Brown"] });
    await applyTagWrite(file, { artist: "Peggy" });
    const { common } = await parseFile(file);
    expect(common.artist).toBe("Peggy");
    expect(common.artists).toEqual(["Peggy", "Danny Brown"]);
  });
});

describe("unwritableReason", () => {
  it("is null for the formats the writer takes", () => {
    for (const name of ["a.flac", "a.mp3", "a.m4a", "a.MP4"]) expect(unwritableReason(name)).toBeNull();
  });

  it("names the format it can't write", () => {
    expect(unwritableReason("/music/a.ogg")).toBe("Legato can't write tags to Ogg files yet, only FLAC, MP3 and M4A");
    expect(unwritableReason("/music/a.opus")).toContain("Opus files");
    expect(unwritableReason("/music/a.wav")).toContain("WAV files");
    expect(unwritableReason("/music/a.ape")).toContain("APE files");
  });
});
