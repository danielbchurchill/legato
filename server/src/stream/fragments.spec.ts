import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readCodecs, readFragmentIndex } from "./fragments.js";
import { VARIANTS, type TranscodedQuality } from "./quality.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "legato-fragments-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A real source, encoded by ffmpeg, then put through the rung's own ffmpeg
// arguments, as stream/cache.ts runs them: the index has to read what the
// server really serves.
function source(name: string, codecArgs: string[], seconds = 5, sampleRate = 44100): string {
  const file = path.join(dir, name);
  execFileSync(
    "ffmpeg",
    ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}:sample_rate=${sampleRate}`, ...codecArgs, file],
    {
      stdio: "ignore",
    },
  );
  return file;
}

function rung(sourcePath: string, quality: TranscodedQuality): string {
  const out = path.join(dir, `${path.basename(sourcePath)}.${quality}.m4a`);
  execFileSync("ffmpeg", ["-i", sourcePath, "-map", "0:a:0", "-vn", ...VARIANTS[quality].encoderArgs, out], {
    stdio: "ignore",
  });
  return out;
}

// ffprobe's own reading of the file: where each packet's data sits and when
// it plays. A fragment's first packet is the first one at or after its moof.
function packets(file: string): { pts: number; pos: number }[] {
  const csv = execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "packet=pts_time,pos",
    "-of",
    "csv=p=0",
    file,
  ]);
  return csv
    .toString()
    .trim()
    .split("\n")
    .map((line) => {
      const [pts, pos] = line.split(",");
      return { pts: Number(pts), pos: Number(pos) };
    });
}

function boxType(bytes: Buffer, at: number): string {
  return bytes.toString("latin1", at + 4, at + 8);
}

describe("readFragmentIndex", () => {
  const cases: [string, string, string[], TranscodedQuality, string][] = [
    ["FLAC", "track.flac", ["-c:a", "flac"], "original-fmp4", "fLaC"],
    ["ALAC", "track.m4a", ["-c:a", "alac"], "original-fmp4", "alac"],
    ["AAC", "aac.m4a", ["-c:a", "aac"], "original-fmp4", "mp4a.40.2"],
    ["the AAC 160 rung", "track.flac", ["-c:a", "flac"], "aac160", "mp4a.40.2"],
  ];

  for (const [label, name, codecArgs, quality, codecs] of cases) {
    it(`maps ${label} as ${quality}: codec string, init segment and every fragment, as ffprobe reads them`, async () => {
      const file = rung(source(name, codecArgs), quality);
      const bytes = readFileSync(file);
      const index = await readFragmentIndex(file);

      expect(index.codecs).toBe(codecs);
      expect(boxType(bytes, 0)).toBe("ftyp");
      expect(boxType(bytes, index.initEnd)).toBe("moof");
      // One-second fragments over five seconds of audio.
      expect(index.fragments.length).toBeGreaterThanOrEqual(5);
      expect(index.fragments[0]).toEqual({ offset: index.initEnd, time: 0 });

      const all = packets(file);
      const firstPts = all[0].pts;
      for (const [i, fragment] of index.fragments.entries()) {
        expect(boxType(bytes, fragment.offset)).toBe("moof");
        const first = all.find((p) => p.pos > fragment.offset)!;
        expect(fragment.time).toBeCloseTo(first.pts - firstPts, 4);
        if (i > 0) expect(fragment.time).toBeGreaterThan(index.fragments[i - 1].time);
      }
      // The media ends with the last mdat; ffmpeg's mfra follows.
      expect(boxType(bytes, index.end)).toBe("mfra");
      expect(index.end).toBeGreaterThan(index.fragments.at(-1)!.offset);
    });
  }

  it("times a 96 kHz FLAC's fragments in its own timescale", async () => {
    const file = rung(source("hires.flac", ["-c:a", "flac"], 4, 96000), "original-fmp4");
    const index = await readFragmentIndex(file);
    expect(index.codecs).toBe("fLaC");
    const all = packets(file);
    const last = index.fragments.at(-1)!;
    expect(last.time).toBeCloseTo(all.find((p) => p.pos > last.offset)!.pts - all[0].pts, 4);
    expect(last.time).toBeGreaterThan(2);
    expect(last.time).toBeLessThan(4);
  });

  it("reads an MP3 carried in MP4 as mp4a.6B, its object type", async () => {
    // Not a rung the server serves (an MP3 plays an AAC rung), but the
    // descriptor path for an mp4a that isn't MPEG-4 audio.
    const mp3 = path.join(dir, "track.mp4");
    const flac = source("for-mp3.flac", ["-c:a", "flac"]);
    try {
      execFileSync(
        "ffmpeg",
        [
          "-i",
          flac,
          "-c:a",
          "libmp3lame",
          "-movflags",
          "+empty_moov+default_base_moof",
          "-frag_duration",
          "1000000",
          "-f",
          "mp4",
          mp3,
        ],
        {
          stdio: "ignore",
        },
      );
    } catch {
      // An ffmpeg built without LAME can't make one; nothing to check then.
      return;
    }
    expect((await readFragmentIndex(mp3)).codecs).toBe("mp4a.6B");
  });

  it("reads the same codec string from the moov alone, which is all an encode under way may have written", async () => {
    for (const [name, codecArgs, codecs] of [
      ["start.flac", ["-c:a", "flac"], "fLaC"],
      ["start.m4a", ["-c:a", "alac"], "alac"],
    ] as const) {
      const file = rung(source(name, [...codecArgs]), "original-fmp4");
      const index = await readFragmentIndex(file);
      expect(await readCodecs(createReadStream(file))).toBe(codecs);
      // Only what comes before the first fragment, a byte at a time.
      const bytes = readFileSync(file).subarray(0, index.initEnd);
      async function* trickle() {
        for (const byte of bytes) yield Buffer.from([byte]);
      }
      expect(await readCodecs(trickle())).toBe(codecs);
      // Short of the end of the moov, there's no answer yet.
      async function* short() {
        yield bytes.subarray(0, index.initEnd - 1);
      }
      await expect(readCodecs(short())).rejects.toThrow("no moov");
    }
  });

  it("refuses a file that isn't fragmented MP4 rather than inventing an index", async () => {
    const flac = source("plain.flac", ["-c:a", "flac"]);
    await expect(readFragmentIndex(flac)).rejects.toThrow();

    const plain = path.join(dir, "plain.m4a");
    execFileSync("ffmpeg", ["-i", flac, "-c:a", "aac", plain], { stdio: "ignore" });
    await expect(readFragmentIndex(plain)).rejects.toThrow("no fragments");

    const truncated = path.join(dir, "truncated.m4a");
    const whole = readFileSync(rung(flac, "original-fmp4"));
    writeFileSync(truncated, whole.subarray(0, whole.length - 200));
    await expect(readFragmentIndex(truncated)).rejects.toThrow("malformed");
  });
});
