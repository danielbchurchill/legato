import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createStreamActivity } from "./activity.js";

// Writes are fire-and-forget from note(), so a test waits for the rename to
// land before reading the file.
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("createStreamActivity", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "legato-stream-activity-test-"));
    file = path.join(dir, "stream-activity");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the time of the first byte as Unix milliseconds", async () => {
    const activity = createStreamActivity(file, { now: () => 1_700_000_000_000 });
    activity.note();
    await settle();
    expect(readFileSync(file, "utf8")).toBe("1700000000000");
    // The rename consumed the partial file rather than leaving it behind.
    expect(existsSync(`${file}.partial`)).toBe(false);
  });

  it("rewrites at most once per interval, however many chunks go out", async () => {
    let clock = 0;
    const activity = createStreamActivity(file, { now: () => clock, writeIntervalMs: 30_000 });

    activity.note();
    await settle();
    clock = 29_999;
    activity.note();
    await settle();
    expect(readFileSync(file, "utf8")).toBe("0");

    clock = 30_000;
    activity.note();
    await settle();
    expect(readFileSync(file, "utf8")).toBe("30000");
  });

  it("writes nothing when no file was named, the standalone-server case", async () => {
    const activity = createStreamActivity(undefined);
    activity.note();
    await settle();
    expect(existsSync(file)).toBe(false);
  });

  it("reports an unwritable file once, not once per interval", async () => {
    let clock = 0;
    const errors: unknown[] = [];
    const activity = createStreamActivity(path.join(dir, "no-such-dir", "stream-activity"), {
      now: () => clock,
      onWriteError: (err) => errors.push(err),
    });
    for (let i = 0; i < 3; i++) {
      activity.note();
      await settle();
      clock += 60_000;
    }
    expect(errors).toHaveLength(1);
  });

  it("meters a stream without changing a byte of it, and records that it flowed", async () => {
    const activity = createStreamActivity(file, { now: () => 42 });
    const body = await text(activity.meter(Readable.from(["abc", "def", "ghi"])));
    expect(body).toBe("abcdefghi");
    await settle();
    expect(readFileSync(file, "utf8")).toBe("42");
  });

  it("records nothing for a stream that never yields a byte", async () => {
    const activity = createStreamActivity(file);
    expect(await text(activity.meter(Readable.from([])))).toBe("");
    await settle();
    expect(existsSync(file)).toBe(false);
  });

  it("destroys the source when the metered side is torn down, as a client hanging up does", async () => {
    const activity = createStreamActivity(undefined);
    const source = new Readable({ read() {} });
    const metered = activity.meter(source);
    metered.destroy();
    await settle();
    expect(source.destroyed).toBe(true);
  });
});
