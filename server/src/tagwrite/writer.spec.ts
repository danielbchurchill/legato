import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDiff } from "./diff.js";
import { applyTagWrite, readWriteMarker, revertTagWrite } from "./writer.js";

let dir: string;
let filePath: string;

// A real, valid FLAC file (not a hand-built header like the scanner
// tests use for WAV) — FLAC's metadata-block structure is what this
// module actually exercises, so the fixture has to be real. ffmpeg is
// already a hard dependency of the server itself (the streaming pipeline).
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-tagwrite-test-"));
  filePath = path.join(dir, "test.flac");
  execFileSync(
    "ffmpeg",
    [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.2",
      "-metadata",
      "title=Original Title",
      "-metadata",
      "artist=Original Artist",
      "-metadata",
      "album=Original Album",
      "-metadata",
      "date=2000",
      "-metadata",
      "track=1",
      filePath,
    ],
    { stdio: "ignore" },
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("computeDiff", () => {
  it("returns an empty diff when nothing changed — the mandatory no-op check", () => {
    expect(computeDiff(filePath, { title: "Original Title" })).toEqual([]);
  });

  it("detects a changed field", () => {
    const diff = computeDiff(filePath, { title: "Fixed Title" });
    expect(diff).toEqual([{ field: "title", oldValue: "Original Title", newValue: "Fixed Title" }]);
  });

  it("detects multiple changed fields, ignoring unchanged ones", () => {
    const diff = computeDiff(filePath, { title: "Original Title", artist: "Fixed Artist", year: 2000 });
    expect(diff).toEqual([{ field: "artist", oldValue: "Original Artist", newValue: "Fixed Artist" }]);
  });

  it("rejects an unsupported format rather than silently doing nothing", () => {
    // .wav, not .mp3 — MP3 is a supported format now (see writer.mp3.spec.ts),
    // so this needs a genuinely unsupported extension to still prove the point.
    expect(() => computeDiff("/fake/path.wav", { title: "x" })).toThrow(/FLAC/);
  });
});

describe("applyTagWrite", () => {
  it("writes the new value and stamps a write marker", async () => {
    const { writeId, writtenMtime } = await applyTagWrite(filePath, { title: "Fixed Title" });

    expect(computeDiff(filePath, { title: "Fixed Title" })).toEqual([]); // now matches on disk
    expect(readWriteMarker(filePath)).toBe(writeId);
    expect(writtenMtime).toBeTruthy();
  });

  it("patches the tag block rather than rewriting the whole file — Picard's bar, not Musicat's", async () => {
    // Musicat rewrote the entire file per tag edit (150%+ of library size
    // for one correction); Picard's reference in-place patching landed at
    // ~21%. A single short field change with padding available should
    // change file size by a few KB at most, nowhere near the audio
    // stream's size.
    const originalSize = statSync(filePath).size;
    await applyTagWrite(filePath, { title: "Fixed Title" });
    const newSize = statSync(filePath).size;
    expect(Math.abs(newSize - originalSize)).toBeLessThan(4096);
  });

  it("never leaves a temp file behind, across repeated writes", async () => {
    await applyTagWrite(filePath, { title: "A" });
    await applyTagWrite(filePath, { title: "B" });
    expect(readdirSync(dir)).toEqual(["test.flac"]);
  });

  it("rejects an unsupported format without touching anything", async () => {
    await expect(applyTagWrite("/fake/path.wav", { title: "x" })).rejects.toThrow(/FLAC/);
  });
});

describe("widened field vocabulary", () => {
  it("round-trips discNo/genre/bpm/label/releaseType/releaseDate — each field readable back by name", async () => {
    await applyTagWrite(filePath, {
      discNo: 2,
      genre: ["Rock", "Psychedelic Rock"],
      bpm: 82,
      label: "Apple Records",
      releaseType: "album",
      releaseDate: "1969-09-26",
    });

    expect(
      computeDiff(filePath, {
        discNo: 2,
        genre: ["Rock", "Psychedelic Rock"],
        bpm: 82,
        label: "Apple Records",
        releaseType: "album",
        releaseDate: "1969-09-26",
      }),
    ).toEqual([]);
  });

  it("writes bpm/label/releaseType to the exact Vorbis fields music-metadata reads back, not TagLib#'s defaults", async () => {
    await applyTagWrite(filePath, { bpm: 120, label: "Apple Records", releaseType: "album" });

    const raw = execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format_tags", "-of", "json", filePath], {
      encoding: "utf8",
    });
    const tags = (JSON.parse(raw).format.tags ?? {}) as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));

    expect(lower.bpm).toBe("120");
    expect(lower.tempo).toBeUndefined();
    expect(lower.label).toBe("Apple Records");
    expect(lower.organization).toBeUndefined();
    expect(lower.releasetype).toBe("album");
    expect(lower.musicbrainz_albumtype).toBeUndefined();
  });

  // scan/tags.ts reads release_date as originaldate ?? releasedate ?? date
  // — writing the raw ORIGINALDATE Vorbis field (rather than going through
  // TagLib#'s tag.year, which targets bare DATE/YEAR) is what makes a
  // manual release-date edit win that priority order on the next scan.
  it("writes releaseDate to the raw ORIGINALDATE Vorbis field music-metadata reads back as originaldate", async () => {
    await applyTagWrite(filePath, { releaseDate: "1969-09-26" });

    const raw = execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format_tags", "-of", "json", filePath], {
      encoding: "utf8",
    });
    const tags = (JSON.parse(raw).format.tags ?? {}) as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));

    expect(lower.originaldate).toBe("1969-09-26");
  });
});

describe("revertTagWrite", () => {
  it("restores the original value, via the same atomic path (a fresh write, not magic undo)", async () => {
    const firstWrite = await applyTagWrite(filePath, { title: "Fixed Title" });
    const reverted = await revertTagWrite(filePath, { title: "Original Title" });

    expect(computeDiff(filePath, { title: "Original Title" })).toEqual([]);
    expect(reverted.writeId).not.toBe(firstWrite.writeId); // a genuinely new write, own marker
    expect(readWriteMarker(filePath)).toBe(reverted.writeId);
  });
});
