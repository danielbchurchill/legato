import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { computePeaks, pcmToPeaks } from "./decode.js";

function makePcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe("pcmToPeaks", () => {
  it("returns one normalized peak value per bucket", () => {
    // 4 buckets, 2 samples each — bucket 0 peaks at 16384 (0.5), bucket 1 at
    // full scale (1.0), the rest silent.
    const pcm = makePcm([100, 16384, 32767, -32768, 0, 0, 0, 0]);
    const peaks = pcmToPeaks(pcm, 4);

    expect(peaks).toHaveLength(4);
    expect(peaks[0]).toBeCloseTo(16384 / 32768);
    expect(peaks[1]).toBeCloseTo(1, 2); // abs(-32768)/32768 rounds to 1
    expect(peaks[2]).toBe(0);
    expect(peaks[3]).toBe(0);
  });

  it("handles negative samples via absolute value", () => {
    const pcm = makePcm([-1000, -2000, 500]);
    const peaks = pcmToPeaks(pcm, 1);
    expect(peaks[0]).toBeCloseTo(2000 / 32768);
  });

  it("returns a silent envelope for empty input rather than dividing by zero", () => {
    expect(pcmToPeaks(Buffer.alloc(0), 10)).toEqual(new Array(10).fill(0));
  });

  it("never exceeds 1.0 even at full-scale samples", () => {
    const pcm = makePcm([32767, -32768]);
    const peaks = pcmToPeaks(pcm, 1);
    expect(peaks[0]).toBeLessThanOrEqual(1);
  });
});

describe("computePeaks (real ffmpeg decode)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "legato-waveform-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a real peak envelope for a real audio file", async () => {
    const filePath = path.join(dir, "tone.flac");
    execFileSync(
      "ffmpeg",
      ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", filePath],
      { stdio: "ignore" },
    );

    const peaks = await computePeaks(filePath, 100);
    expect(peaks).toHaveLength(100);
    // A sine wave should register real amplitude somewhere, not silence.
    expect(Math.max(...peaks)).toBeGreaterThan(0.1);
    expect(peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it("rejects a nonexistent file with a real error, not a hang", async () => {
    await expect(computePeaks(path.join(dir, "does-not-exist.flac"))).rejects.toThrow();
  });
});
