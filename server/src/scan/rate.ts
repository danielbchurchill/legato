// A stage's honest rate/ETA (issue #123, H1): "estimating..." until we've
// actually watched this stage run for a while, never a guess dressed up as
// a number from two samples a second apart. `now` is injectable so tests
// can drive this with a fake clock instead of real sleeps.

const DEFAULT_WINDOW_MS = 20_000;

export class RateEstimator {
  #windowMs: number;
  #startedAt: number | null = null;
  #samples: { t: number; done: number }[] = [];

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.#windowMs = windowMs;
  }

  // Called once per stage, or whenever a resumed run re-enters a stage —
  // old samples belong to a different stage (or a different server
  // process entirely) and have no business predicting this one's rate.
  reset(): void {
    this.#startedAt = null;
    this.#samples = [];
  }

  sample(done: number, now: number = Date.now()): void {
    if (this.#startedAt === null) this.#startedAt = now;
    this.#samples.push({ t: now, done });
    const cutoff = now - this.#windowMs;
    // Keep at least one sample even past the cutoff — a rate needs two
    // points, and dropping down to zero would make a fast stage (finishes
    // in under a window) report no rate at all right as it completes.
    while (this.#samples.length > 1 && this.#samples[0].t < cutoff) this.#samples.shift();
  }

  // Files/sec over whatever window of samples survived eviction. null with
  // fewer than two samples, or two samples with no time between them.
  // Takes `now` only for call-site symmetry with sample()/etaSeconds() —
  // the rate itself is derived purely from the samples' own timestamps.
  rate(_now: number = Date.now()): number | null {
    if (this.#samples.length < 2) return null;
    const first = this.#samples[0];
    const last = this.#samples[this.#samples.length - 1];
    const elapsedSec = (last.t - first.t) / 1000;
    if (elapsedSec <= 0) return null;
    return (last.done - first.done) / elapsedSec;
  }

  // Withheld — the UI shows "estimating..." — until this stage has been
  // sampled for at least the full window, regardless of how the sliding
  // window above has since trimmed old samples out of `rate()`'s own view.
  etaSeconds(remaining: number, now: number = Date.now()): number | null {
    if (this.#startedAt === null || now - this.#startedAt < this.#windowMs) return null;
    if (remaining <= 0) return 0;
    const r = this.rate(now);
    if (!r || r <= 0) return null;
    return remaining / r;
  }
}
