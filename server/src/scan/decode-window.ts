// Issue #189: the 'enrich_queued' stage spends nearly all its time on one
// ffmpeg waveform decode per file (waveform/peaks.ts), and it used to await
// each one before starting the next — so a scan only ever held one of the
// media slots #111's shared limiter (media/queue.ts) hands out, however
// many the machine has. This lets a stage keep a few decodes going at once
// while still awaiting everything else it does per file in order.
//
// The window bounds how many tasks this stage has *started*; it is not a
// second limiter. Every decode still goes through runMediaTask, so scan
// decodes, cover resizes and stream transcodes keep drawing on one budget.

// The scan's share of the shared media limit: one slot fewer than the
// limit, never fewer than one. media/queue.ts already moves a playback
// request ahead of every *waiting* background task, but it can't take a
// slot back from a decode that's already running. If the scan filled every
// slot, someone pressing play on the Pi (4 cores, limit 3) would wait behind
// an in-progress decode. Holding one slot back means a stream transcode or
// cover resize always finds a free slot, whatever stage the scan is in. On a
// single-core host (limit 1) the scan still gets its one slot, exactly what
// it had before this window existed.
export function scanDecodeShare(mediaLimit: number): number {
  return Math.max(1, mediaLimit - 1);
}

export type DecodeWindow = {
  // Starts task once fewer than `size` are in flight, waiting for one to
  // finish first if not. Resolves when the task has *started*, not when it
  // has finished. Task must handle its own errors: a rejection here
  // would surface from an unrelated later add() or drain().
  add(task: () => Promise<void>): Promise<void>;
  // Resolves once every task started so far has finished. Callers run this
  // before persisting a stage cursor, so a checkpoint still means "every
  // file before this seq is completely done" — the guarantee resume relies
  // on.
  drain(): Promise<void>;
};

export function createDecodeWindow(size: number): DecodeWindow {
  const inFlight = new Set<Promise<void>>();

  return {
    async add(task) {
      while (inFlight.size >= size) await Promise.race(inFlight);
      const running: Promise<void> = task().finally(() => inFlight.delete(running));
      inFlight.add(running);
    },
    async drain() {
      await Promise.all(inFlight);
    },
  };
}
