import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDiff } from "./diff.js";
import { applyTagWrite, readWriteMarker, revertTagWrite } from "./writer.js";

let dir: string;
let filePath: string;

// Mirrors writer.spec.ts's FLAC fixture, aimed at MP3/ID3v2 instead — a
// real ffmpeg-authored file, not a hand-built header, since ID3v2's frame
// structure (and whether ffmpeg also tacks on an ID3v1 trailer) is exactly
// what this module has to cope with.
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-tagwrite-mp3-test-"));
  filePath = path.join(dir, "test.mp3");
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

describe("computeDiff (MP3)", () => {
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
});

describe("applyTagWrite (MP3)", () => {
  it("writes the new value and stamps a write marker", async () => {
    const { writeId, writtenMtime } = await applyTagWrite(filePath, { title: "Fixed Title" });

    expect(computeDiff(filePath, { title: "Fixed Title" })).toEqual([]); // now matches on disk
    expect(readWriteMarker(filePath)).toBe(writeId);
    expect(writtenMtime).toBeTruthy();
  });

  it("never leaves a temp file behind, across repeated writes", async () => {
    await applyTagWrite(filePath, { title: "A" });
    await applyTagWrite(filePath, { title: "B" });
    expect(readdirSync(dir)).toEqual(["test.mp3"]);
  });
});

describe("widened field vocabulary (MP3)", () => {
  it("round-trips discNo/genre/bpm/label/releaseType — each field readable back by name", async () => {
    await applyTagWrite(filePath, {
      discNo: 2,
      genre: ["Rock", "Psychedelic Rock"],
      bpm: 82,
      label: "Apple Records",
      releaseType: "album",
    });

    expect(
      computeDiff(filePath, {
        discNo: 2,
        genre: ["Rock", "Psychedelic Rock"],
        bpm: 82,
        label: "Apple Records",
        releaseType: "album",
      }),
    ).toEqual([]);
  });

  // The actual point of this test: verified against music-metadata (this
  // app's own tag reader), not just against TagLib# reading back its own
  // write. FLAC needed the raw Vorbis field for these three (see
  // writer.spec.ts) because TagLib#'s named properties default to a
  // *different* field than music-metadata reads. ID3v2 turned out not to
  // have that problem: TagLib#'s beatsPerMinute/publisher/
  // musicBrainzReleaseType write TBPM/TPUB/TXXX:"MusicBrainz Album Type" —
  // exactly what music-metadata's ID3v24TagMapper maps to bpm/label/
  // releasetype — so fields.ts uses those named properties directly for
  // MP3, unlike FLAC.
  it("writes bpm/label/releaseType to the exact ID3v2 frames music-metadata reads back", async () => {
    await applyTagWrite(filePath, { bpm: 120, label: "Apple Records", releaseType: "album" });

    const { common } = await parseFile(filePath, { duration: true });
    expect(common.bpm).toBe(120);
    expect(common.label).toEqual(["Apple Records"]);
    expect(common.releasetype).toEqual(["album"]);
  });
});

describe("revertTagWrite (MP3)", () => {
  it("restores the original value, via the same atomic path (a fresh write, not magic undo)", async () => {
    const firstWrite = await applyTagWrite(filePath, { title: "Fixed Title" });
    const reverted = await revertTagWrite(filePath, { title: "Original Title" });

    expect(computeDiff(filePath, { title: "Original Title" })).toEqual([]);
    expect(reverted.writeId).not.toBe(firstWrite.writeId); // a genuinely new write, own marker
    expect(readWriteMarker(filePath)).toBe(reverted.writeId);
  });
});
