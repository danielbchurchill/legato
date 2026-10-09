import { MEDIA_CONCURRENCY_LIMIT } from "../config.js";

// Issue #111: one shared limit for every child process this server spawns
// to decode or transcode media — ffmpeg (stream transcodes, cover
// resizing, waveform decode) and fpcalc (fingerprinting) alike. Before
// this, nothing stopped a fresh library scan's fingerprinting/cover/
// waveform work from spawning exactly as many concurrent processes as it
// had files left to look at, which is invisible on a desktop and starves
// a low-power host (see config.ts's MEDIA_CONCURRENCY_LIMIT for the actual
// number and why it's shaped that way).
//
// Playback jumps the *queue*, not a running process: a background spawn
// already under way when a playback request arrives runs to completion
// undisturbed, and only work still waiting for a slot gets reordered
// ahead of it. Killing an in-progress background spawn to free a slot
// immediately would trade one kind of playback stall (queued behind
// background work already running) for a worse one — the file that job
// was mid-way through has to restart from scratch, and on a scan touching
// tens of thousands of files that's real wasted CPU, not just a delay.
export type MediaPriority = "playback" | "background";

type Waiter = () => void;

// A factory rather than bare module state so tests can exercise ordering
// and the limit against a small, disposable queue instead of either
// mocking os.cpus() or fighting over one shared singleton's state between
// test cases. The real server still gets exactly one shared instance,
// exported below.
export function createMediaQueue(limit: number) {
  let active = 0;
  const playbackWaiters: Waiter[] = [];
  const backgroundWaiters: Waiter[] = [];

  // Playback-priority waiters drain first, and within a priority, FIFO —
  // so a scan's own fingerprint/cover/waveform work still finishes in the
  // order it was queued relative to itself, and a playback request never
  // waits behind a *later* playback request either.
  function dequeueNext(): Waiter | undefined {
    return playbackWaiters.shift() ?? backgroundWaiters.shift();
  }

  // Resolves once a concurrency slot is free, with a release() the caller
  // must call exactly once when its own child process is actually done —
  // not necessarily when the async function that requested the slot
  // returns (a route that spawns and hands back a stream returns well
  // before that stream finishes).
  function acquireMediaSlot(priority: MediaPriority): Promise<() => void> {
    return new Promise((resolve) => {
      let released = false;
      const release = () => {
        if (released) return; // safe to call more than once (e.g. both a
        released = true; // process 'close' and a client disconnect firing)
        active--;
        const next = dequeueNext();
        if (next) {
          active++;
          next();
        }
      };

      if (active < limit) {
        active++;
        resolve(release);
        return;
      }

      const grant = () => resolve(release);
      (priority === "playback" ? playbackWaiters : backgroundWaiters).push(grant);
    });
  }

  // The common case: a plain async function whose whole lifetime — spawn
  // through exit — is the thing being rate-limited. Every shared-queue
  // caller goes through this rather than acquireMediaSlot directly.
  async function runMediaTask<T>(priority: MediaPriority, task: () => Promise<T>): Promise<T> {
    const release = await acquireMediaSlot(priority);
    try {
      return await task();
    } finally {
      release();
    }
  }

  // How many slots are taken right now: for specs that check a slot was
  // given back.
  const inUse = () => active;

  return { acquireMediaSlot, runMediaTask, inUse };
}

const sharedMediaQueue = createMediaQueue(MEDIA_CONCURRENCY_LIMIT);

export const runMediaTask = sharedMediaQueue.runMediaTask;
export const mediaSlotsInUse = sharedMediaQueue.inUse;
