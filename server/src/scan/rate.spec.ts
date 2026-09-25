import { describe, expect, test } from "bun:test";
import { RateEstimator } from "./rate.js";

// H1: "estimating..." (etaSeconds returning null) until a stage has
// actually been watched for a full window, never a guess from two samples
// a second apart. Every test here drives the estimator with an explicit
// `now` rather than real sleeps, so the 20s gate is exercised in
// milliseconds of wall-clock test time.
describe("RateEstimator", () => {
  test("rate is null with fewer than two samples", () => {
    const rate = new RateEstimator(20_000);
    expect(rate.rate(0)).toBeNull();
    rate.sample(10, 0);
    expect(rate.rate(0)).toBeNull();
  });

  test("rate is files/sec across the first and last surviving sample", () => {
    const rate = new RateEstimator(20_000);
    rate.sample(0, 0);
    rate.sample(100, 10_000);
    expect(rate.rate(10_000)).toBe(10);
  });

  test("etaSeconds withholds (null) before a full window of samples has been seen", () => {
    const rate = new RateEstimator(20_000);
    rate.sample(0, 0);
    rate.sample(500, 10_000); // 10s in — under the 20s window
    expect(rate.etaSeconds(500, 10_000)).toBeNull();
  });

  test("etaSeconds reports once the window has fully elapsed since the first sample", () => {
    const rate = new RateEstimator(20_000);
    rate.sample(0, 0);
    rate.sample(1_000, 20_000); // exactly 20s in, 50 files/sec
    // 1000 remaining at 50/sec = 20s
    expect(rate.etaSeconds(1_000, 20_000)).toBe(20);
  });

  test("etaSeconds is 0 once nothing remains", () => {
    const rate = new RateEstimator(20_000);
    rate.sample(0, 0);
    rate.sample(1_000, 20_000);
    expect(rate.etaSeconds(0, 20_000)).toBe(0);
  });

  test("sliding window evicts old samples but keeps at least one so a finishing stage still reports a rate", () => {
    const rate = new RateEstimator(1_000);
    rate.sample(0, 0);
    rate.sample(10, 500);
    rate.sample(20, 1_500); // evicts the t=0 sample (outside the 1s window), keeps t=500
    expect(rate.rate(1_500)).toBe(10); // (20-10)/((1500-500)/1000)
  });

  test("reset() clears samples and the window start, re-arming the estimating gate", () => {
    const rate = new RateEstimator(20_000);
    rate.sample(0, 0);
    rate.sample(1_000, 25_000);
    expect(rate.etaSeconds(0, 25_000)).toBe(0);

    rate.reset();
    expect(rate.rate(25_000)).toBeNull();
    // Freshly reset, sampled again right away — under a new window, so
    // still estimating even though the wall-clock 'now' is unchanged.
    rate.sample(0, 25_000);
    expect(rate.etaSeconds(100, 25_500)).toBeNull();
  });
});
