import { spawn } from "node:child_process";

// Sample rate for the *decode*, not the original file — a peak envelope
// only needs enough resolution to find the loudest sample in each bucket,
// and this library's tracks average several minutes; decoding at 8kHz
// mono keeps ffmpeg's output small and fast regardless of the source's
// real sample rate, which matters more once this runs synchronously for
// every file in a scan (mirroring cover/extract.ts's own inline,
// non-fatal-on-failure pattern).
const DECODE_SAMPLE_RATE = 8000;
const DEFAULT_BUCKET_COUNT = 2000;

// Decodes to raw signed 16-bit mono PCM via the same ffmpeg dependency the
// server already has for streaming and cover-art resizing, then folds the
// sample stream down to one peak-amplitude value per bucket (0..1,
// normalized against the format's own full scale) — a single-value
// envelope rather than a min/max pair per bucket: simpler to store and
// render, and sufficient for a scrubber-style waveform bar, which is all
// the transport dock needs.
export function decodePcm(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      String(DECODE_SAMPLE_RATE),
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let stderr = "";

    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0 || chunks.length === 0) {
        reject(new Error(`ffmpeg failed to decode audio (exit ${code}): ${stderr.trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

export function pcmToPeaks(pcm: Buffer, bucketCount: number = DEFAULT_BUCKET_COUNT): number[] {
  const sampleCount = Math.floor(pcm.length / 2); // 2 bytes per s16le sample
  if (sampleCount === 0) return new Array(bucketCount).fill(0);

  const peaks = new Array(bucketCount).fill(0);
  const samplesPerBucket = sampleCount / bucketCount;

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.floor(bucket * samplesPerBucket);
    const end = Math.min(sampleCount, Math.floor((bucket + 1) * samplesPerBucket));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const sample = Math.abs(pcm.readInt16LE(i * 2));
      if (sample > peak) peak = sample;
    }
    peaks[bucket] = peak / 32768;
  }

  return peaks;
}

export async function computePeaks(filePath: string, bucketCount: number = DEFAULT_BUCKET_COUNT): Promise<number[]> {
  const pcm = await decodePcm(filePath);
  return pcmToPeaks(pcm, bucketCount);
}
