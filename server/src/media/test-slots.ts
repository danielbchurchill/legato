// Test-only: holds slots on the shared media queue, so a spec can make a
// track wait for one, the way it does behind other encodes at the limit.
// Not a *.spec.ts, so `bun test` never runs it as a suite of its own.
import { MEDIA_CONCURRENCY_LIMIT } from "../config.js";
import { mediaSlotsInUse, runMediaTask } from "./queue.js";

/** Takes every slot still free, with background work that runs until released. */
export function fillMediaSlots(): { release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  while (mediaSlotsInUse() < MEDIA_CONCURRENCY_LIMIT) void runMediaTask("background", () => gate);
  return { release };
}

/** A playback task that waits for a slot if none is free, then holds it until released. */
export function queuePlayback(): { granted: Promise<void>; release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let given!: () => void;
  const granted = new Promise<void>((resolve) => (given = resolve));
  void runMediaTask("playback", () => {
    given();
    return gate;
  });
  return { granted, release };
}
