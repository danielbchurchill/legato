// Issue #123: "feel normal at 180k files" means not broadcasting a
// scan:progress event for every single file — about 4/s is the budget. A
// gate rather than a timer/interval: the scan loop already calls this once
// per file it visits, so there's no separate clock to drive, and `force`
// lets a stage's start/end always get through regardless of timing.
export function createProgressGate(intervalMs: number, now: () => number = Date.now) {
  let last = -Infinity;
  return (force = false): boolean => {
    const t = now();
    if (!force && t - last < intervalMs) return false;
    last = t;
    return true;
  };
}
