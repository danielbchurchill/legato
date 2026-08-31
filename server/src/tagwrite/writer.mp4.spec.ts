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

// Mirrors writer.spec.ts's FLAC fixture, aimed at an M4A/MP4 container —
// real ffmpeg-authored AAC, not a hand-built atom tree.
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-tagwrite-mp4-test-"));
  filePath = path.join(dir, "test.m4a");
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

describe("computeDiff (MP4)", () => {
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

describe("applyTagWrite (MP4)", () => {
  it("writes the new value and stamps a write marker", async () => {
    const { writeId, writtenMtime } = await applyTagWrite(filePath, { title: "Fixed Title" });

    expect(computeDiff(filePath, { title: "Fixed Title" })).toEqual([]); // now matches on disk
    expect(readWriteMarker(filePath)).toBe(writeId);
    expect(writtenMtime).toBeTruthy();
  });

  it("never leaves a temp file behind, across repeated writes", async () => {
    await applyTagWrite(filePath, { title: "A" });
    await applyTagWrite(filePath, { title: "B" });
    expect(readdirSync(dir)).toEqual(["test.m4a"]);
  });
});

describe("widened field vocabulary (MP4)", () => {
  it("round-trips discNo/genre/bpm/label/releaseType — each field readable back by name", async () => {
    await applyTagWrite(filePath, {
      discNo: 2,
      genre: ["Rock", "Psychedelic Rock"],
      bpm: 82,
      label: "Apple Records",
      releaseType: "album",
    });

    // TagLib# round-trips this cleanly through its own reader: multi-value
    // MP4 text atoms are "; "-joined on write and re-split on read (see
    // appleTag.ts's setQuickTimeStrings/getQuickTimeStrings), so the array
    // shape survives a read through the same library that wrote it.
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
  // write. MP4 repeats FLAC's named-property bug for exactly one field:
  // TagLib#'s `publisher` writes a `----:com.apple.iTunes:publisher`
  // freeform atom, but music-metadata's MP4TagMapper only recognizes
  // `----:com.apple.iTunes:LABEL` as 'label' — a value written through the
  // named property would silently vanish on the app's own next scan.
  // fields.ts writes the LABEL atom directly instead (setItunesStrings)
  // rather than going through tag.publisher. beatsPerMinute (tmpo) and
  // musicBrainzReleaseType (`----:...:MusicBrainz Album Type`) both matched
  // music-metadata's expectations already, so those go through the named
  // properties same as FLAC's disc/genre.
  it("writes label to the LABEL freeform atom music-metadata reads back, not TagLib#'s publisher default", async () => {
    await applyTagWrite(filePath, { bpm: 120, label: "Apple Records", releaseType: "album" });

    const { common, native } = await parseFile(filePath, { duration: true });
    expect(common.bpm).toBe(120);
    expect(common.label).toEqual(["Apple Records"]);
    expect(common.releasetype).toEqual(["album"]);

    const nativeIds = native.iTunes?.map((tag) => tag.id) ?? [];
    expect(nativeIds).toContain("----:com.apple.iTunes:LABEL");
    // The bug this test exists to catch: had label gone through TagLib#'s
    // named `publisher` property instead, this atom would exist instead of
    // (or alongside) LABEL, and music-metadata would never see it.
    expect(nativeIds).not.toContain("----:com.apple.iTunes:publisher");
  });

  // A caveat worth documenting rather than hiding: MP4/iTunes has no
  // Vorbis-style repeated-key convention for multi-valued text fields.
  // TagLib# stores a multi-genre write as ONE atom containing "Rock;
  // Psychedelic Rock" (see setQuickTimeStrings above) — and while TagLib#
  // itself re-splits that back into an array on read (the test above this
  // one), music-metadata's MP4 parser does not: it reads the atom as a
  // single joined string. A multi-genre MP4 write is real and round-trips
  // through this app's own write/diff path, but the app's *scanner* will
  // see one semicolon-joined genre value, not two, on its next pass. Not a
  // wrong-field bug like label above — a real format/reader limitation,
  // flagged here instead of silently assumed away.
  it("music-metadata reads a multi-genre MP4 write back as one semicolon-joined value", async () => {
    await applyTagWrite(filePath, { genre: ["Rock", "Psychedelic Rock"] });

    const { common } = await parseFile(filePath, { duration: true });
    expect(common.genre).toEqual(["Rock; Psychedelic Rock"]);
  });
});

describe("revertTagWrite (MP4)", () => {
  it("restores the original value, via the same atomic path (a fresh write, not magic undo)", async () => {
    const firstWrite = await applyTagWrite(filePath, { title: "Fixed Title" });
    const reverted = await revertTagWrite(filePath, { title: "Original Title" });

    expect(computeDiff(filePath, { title: "Original Title" })).toEqual([]);
    expect(reverted.writeId).not.toBe(firstWrite.writeId); // a genuinely new write, own marker
    expect(readWriteMarker(filePath)).toBe(reverted.writeId);
  });
});
