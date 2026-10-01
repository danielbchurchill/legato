import { rename, writeFile } from "node:fs/promises";
import { pipeline, Transform, type Readable } from "node:stream";
import { STREAM_ACTIVITY_FILE } from "../config.js";

// Issue #130: the desktop shell's "keep this computer awake while serving"
// needs to know when the server last streamed, and it holds the power
// assertion only while that was recently. "Streaming" here means a media
// byte left GET /files/:id/stream. A request arriving is not enough: a
// paused <audio> element keeps its connection open and stops reading, and
// TCP backpressure then stops the bytes too. So the clock only moves while
// someone is actually being fed audio.
//
// The answer goes to a file the shell names (LEGATO_STREAM_ACTIVITY_FILE,
// set in src-tauri/src/server_process.rs), not to an HTTP route. Every
// /api route needs a session since #112, and the shell has none. A file
// needs no auth exemption, and the Rust side needs no HTTP client. A
// standalone server (the Pi, Docker) never sets the variable, so it never
// writes anything.
//
// The file holds one number, the Unix time in milliseconds of the last
// byte, rewritten at most once per WRITE_INTERVAL_MS. The shell's idle
// window is minutes long (keep_awake.rs), so up to 30 seconds of lag
// changes nothing. A busy stream still costs at most one small write
// every 30 seconds, not one per 64 KiB chunk.
export const WRITE_INTERVAL_MS = 30_000;

export type StreamActivity = {
  /** Records that a media byte just went out. Cheap to call per chunk. */
  note(): void;
  /** `source`, passed through unchanged, calling note() on every chunk. */
  meter(source: Readable): Readable;
};

export function createStreamActivity(
  file: string | undefined,
  {
    now = Date.now,
    writeIntervalMs = WRITE_INTERVAL_MS,
    onWriteError = (err: unknown) => console.error(`stream activity: couldn't write ${file}:`, err),
  }: { now?: () => number; writeIntervalMs?: number; onWriteError?: (err: unknown) => void } = {},
): StreamActivity {
  let lastWriteAt = -Infinity;
  let writing = false;
  let reportedError = false;

  const note = () => {
    if (!file || writing) return;
    const at = now();
    if (at - lastWriteAt < writeIntervalMs) return;
    lastWriteAt = at;
    writing = true;
    // Written beside the target and renamed over it, so the shell never
    // reads a half-written number. A rename within one directory is atomic.
    const partial = `${file}.partial`;
    writeFile(partial, String(at))
      .then(() => rename(partial, file))
      .catch((err) => {
        // Once per process: a data dir that refuses this write refuses
        // every one, and the log doesn't need a line per 30 seconds.
        if (!reportedError) onWriteError(err);
        reportedError = true;
      })
      .finally(() => {
        writing = false;
      });
  };

  const meter = (source: Readable) => {
    const counted = new Transform({
      transform(chunk, _encoding, callback) {
        note();
        callback(null, chunk);
      },
    });
    // pipeline, not pipe: a client hanging up destroys `counted`, and this
    // destroys the file or ffmpeg read behind it too, rather than leaving it
    // open. A read error travels the other way, to Fastify.
    return pipeline(source, counted, () => undefined);
  };

  return { note, meter };
}

export const streamActivity = createStreamActivity(STREAM_ACTIVITY_FILE);
