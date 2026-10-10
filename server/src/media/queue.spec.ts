import { describe, expect, it } from "bun:test";
import { createMediaQueue } from "./queue.js";

// A promise plus the resolve function that settles it, so a test can hold
// a "task" open for exactly as long as it needs to observe queue state
// mid-flight, then let it finish on command.
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createMediaQueue", () => {
  it("runs up to the limit concurrently and queues the rest", async () => {
    const queue = createMediaQueue(2);
    const gates = [deferred(), deferred(), deferred()];
    let concurrent = 0;
    let maxConcurrent = 0;

    const runs = gates.map((gate) =>
      queue.runMediaTask("background", async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate.promise;
        concurrent--;
      }),
    );

    // Give the first two tasks a chance to actually start before releasing
    // anything — the third should still be waiting for a slot.
    await Promise.resolve();
    await Promise.resolve();

    gates[0].resolve();
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);

    expect(maxConcurrent).toBe(2);
  });

  it("grants a playback waiter a slot before an earlier-queued background waiter", async () => {
    const queue = createMediaQueue(1);
    const order: string[] = [];
    const heldGate = deferred();
    const backgroundGate = deferred();
    const playbackGate = deferred();

    // Occupies the only slot so the two waiters below actually have to
    // queue instead of running immediately.
    const holder = queue.runMediaTask("background", async () => {
      order.push("holder");
      await heldGate.promise;
    });

    // Enqueued first, but background.
    const background = queue.runMediaTask("background", async () => {
      order.push("background");
      await backgroundGate.promise;
    });
    await Promise.resolve();

    // Enqueued second, but playback — this is issue #111's actual
    // requirement: it must still be granted the freed slot first.
    const playback = queue.runMediaTask("playback", async () => {
      order.push("playback");
      await playbackGate.promise;
    });
    await Promise.resolve();

    heldGate.resolve();
    await holder;
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["holder", "playback"]);

    playbackGate.resolve();
    await playback;
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["holder", "playback", "background"]);

    backgroundGate.resolve();
    await background;
  });

  it("keeps FIFO order among waiters of the same priority", async () => {
    const queue = createMediaQueue(1);
    const order: string[] = [];
    const heldGate = deferred();

    const holder = queue.runMediaTask("background", async () => {
      await heldGate.promise;
    });

    const second = queue.runMediaTask("background", async () => {
      order.push("second");
    });
    await Promise.resolve();
    const third = queue.runMediaTask("background", async () => {
      order.push("third");
    });
    await Promise.resolve();

    heldGate.resolve();
    await holder;
    await second;
    await third;

    expect(order).toEqual(["second", "third"]);
  });

  it("resolves with the task's own return value", async () => {
    const queue = createMediaQueue(1);
    await expect(queue.runMediaTask("playback", async () => 42)).resolves.toBe(42);
  });

  it("rejects with the task's own error and still frees the slot for the next waiter", async () => {
    const queue = createMediaQueue(1);
    await expect(
      queue.runMediaTask("playback", async () => {
        throw new Error("transcode failed");
      }),
    ).rejects.toThrow("transcode failed");

    // A failed task must not leave the slot permanently held — the next
    // task should run immediately, not hang forever.
    await expect(queue.runMediaTask("playback", async () => "ok")).resolves.toBe("ok");
  });

  it("takes a task out of the queue when its signal aborts while it waits", async () => {
    const queue = createMediaQueue(1);
    const held = deferred();
    void queue.runMediaTask("playback", () => held.promise);
    const giveUp = new AbortController();
    let ran = false;
    const waiting = queue.runMediaTask(
      "playback",
      async () => {
        ran = true;
      },
      giveUp.signal,
    );
    expect(queue.playbackWaiting()).toBe(1);
    giveUp.abort(new Error("nobody's listening"));
    await expect(waiting).rejects.toThrow("nobody's listening");
    expect(queue.playbackWaiting()).toBe(0);

    // The slot goes to the next task, not the one that gave up.
    held.resolve();
    await expect(queue.runMediaTask("playback", async () => "next")).resolves.toBe("next");
    expect(ran).toBe(false);
    expect(queue.inUse()).toBe(0);
    // Already aborted: never waits at all.
    await expect(queue.runMediaTask("playback", async () => "never", giveUp.signal)).rejects.toThrow("nobody's listening");
  });

  it("says when a playback task starts waiting, and never for background work", async () => {
    const queue = createMediaQueue(1);
    const held = deferred();
    void queue.runMediaTask("background", () => held.promise);
    const heard: number[] = [];
    const off = queue.onPlaybackWaiting(() => heard.push(queue.playbackWaiting()));

    void queue.runMediaTask("background", async () => {});
    expect(heard).toEqual([]);
    void queue.runMediaTask("playback", async () => {});
    void queue.runMediaTask("playback", async () => {});
    expect(heard).toEqual([1, 2]);
    off();
    void queue.runMediaTask("playback", async () => {});
    expect(heard).toEqual([1, 2]);
    held.resolve();
  });

  it("acquireMediaSlot's release() is safe to call more than once", async () => {
    const queue = createMediaQueue(1);
    const release = await queue.acquireMediaSlot("playback");
    release();
    release(); // must not double-free the slot and grant it out twice

    const release2 = await queue.acquireMediaSlot("playback");
    release2();
  });
});
