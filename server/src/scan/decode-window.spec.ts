import { describe, expect, it } from "bun:test";
import { createMediaQueue } from "../media/queue.js";
import { createDecodeWindow, scanDecodeShare } from "./decode-window.js";

// A promise the test resolves by hand, standing in for an ffmpeg decode
// that hasn't exited yet.
function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("scanDecodeShare", () => {
  it("leaves one slot of the media limit free, but never drops below one", () => {
    expect(scanDecodeShare(1)).toBe(1);
    expect(scanDecodeShare(2)).toBe(1);
    expect(scanDecodeShare(3)).toBe(2); // the Pi: 4 cores, limit 3
    expect(scanDecodeShare(8)).toBe(7);
  });
});

describe("createDecodeWindow", () => {
  it("never has more than its size in flight, and add() waits for room", async () => {
    const window = createDecodeWindow(2);
    const decodes = [held(), held(), held()];
    let active = 0;
    let peak = 0;
    const task = (d: { promise: Promise<void> }) => async () => {
      active++;
      peak = Math.max(peak, active);
      await d.promise;
      active--;
    };

    await window.add(task(decodes[0]));
    await window.add(task(decodes[1]));
    let thirdStarted = false;
    const third = window.add(task(decodes[2])).then(() => (thirdStarted = true));

    await settleMicrotasks();
    expect(active).toBe(2);
    expect(thirdStarted).toBe(false);

    decodes[0].release();
    await third;
    expect(thirdStarted).toBe(true);
    expect(peak).toBe(2);

    decodes[1].release();
    decodes[2].release();
    await window.drain();
    expect(active).toBe(0);
  });

  it("drain() resolves only once every started task has finished", async () => {
    const window = createDecodeWindow(3);
    const decodes = [held(), held()];
    let finished = 0;
    for (const d of decodes) {
      await window.add(async () => {
        await d.promise;
        finished++;
      });
    }

    let drained = false;
    const draining = window.drain().then(() => (drained = true));
    decodes[0].release();
    await settleMicrotasks();
    expect(drained).toBe(false);

    decodes[1].release();
    await draining;
    expect(finished).toBe(2);
  });

  it("drain() on an empty window resolves straight away", async () => {
    await createDecodeWindow(1).drain();
  });

  it("a playback task starts at once while the scan's share of the limit is busy", async () => {
    // The Pi's numbers: limit 3, so the scan may hold 2 decodes at a time.
    const queue = createMediaQueue(3);
    const window = createDecodeWindow(scanDecodeShare(3));
    const decodes = [held(), held(), held()];
    for (const d of decodes) {
      // Each decode draws on the same queue a stream transcode does, the way
      // waveform/decode.ts's computePeaks goes through runMediaTask.
      void window.add(() => queue.runMediaTask("background", () => d.promise));
    }
    await settleMicrotasks();

    let playbackStarted = false;
    const playback = queue.runMediaTask("playback", async () => {
      playbackStarted = true;
    });
    await settleMicrotasks();
    expect(playbackStarted).toBe(true);
    await playback;

    for (const d of decodes) d.release();
    await window.drain();
  });

  it("the same playback task would wait if the scan were allowed the whole limit", async () => {
    // The case scanDecodeShare exists to prevent, kept as a test so the
    // reason doesn't quietly disappear: media/queue.ts reorders waiters, but
    // it can't take a slot back from a decode that's already running.
    const queue = createMediaQueue(3);
    const window = createDecodeWindow(3);
    const decodes = [held(), held(), held()];
    for (const d of decodes) void window.add(() => queue.runMediaTask("background", () => d.promise));
    await settleMicrotasks();

    let playbackStarted = false;
    const playback = queue.runMediaTask("playback", async () => {
      playbackStarted = true;
    });
    await settleMicrotasks();
    expect(playbackStarted).toBe(false);

    decodes[0].release();
    await playback;
    expect(playbackStarted).toBe(true);
    decodes[1].release();
    decodes[2].release();
    await window.drain();
  });
});
