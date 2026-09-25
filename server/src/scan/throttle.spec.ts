import { describe, expect, test } from "bun:test";
import { createProgressGate } from "./throttle.js";

// Issue #123: progress events throttled to about 4/s (250ms apart). A fake
// clock rather than real sleeps, so this asserts the gate's spacing logic
// directly instead of timing flakiness.
describe("createProgressGate", () => {
  test("lets the first call through", () => {
    let now = 0;
    const gate = createProgressGate(250, () => now);
    expect(gate()).toBe(true);
  });

  test("blocks calls inside the interval, opens once it elapses", () => {
    let now = 0;
    const gate = createProgressGate(250, () => now);
    expect(gate()).toBe(true);
    now = 100;
    expect(gate()).toBe(false);
    now = 249;
    expect(gate()).toBe(false);
    now = 250;
    expect(gate()).toBe(true);
  });

  test("force always opens the gate and resets its own clock", () => {
    let now = 0;
    const gate = createProgressGate(250, () => now);
    expect(gate()).toBe(true);
    now = 10;
    expect(gate(true)).toBe(true);
    now = 20;
    // forced open reset `last`, so a non-forced call right after is still gated
    expect(gate()).toBe(false);
  });

  test("about 4 opens per simulated second of steady 1ms-apart calls", () => {
    let now = 0;
    const gate = createProgressGate(250, () => now);
    let opens = 0;
    for (let i = 0; i < 1000; i++) {
      if (gate()) opens++;
      now += 1;
    }
    expect(opens).toBe(4);
  });
});
