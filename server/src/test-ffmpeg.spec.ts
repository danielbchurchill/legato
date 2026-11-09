import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { runTool, tryFfmpeg, tryTool } from "./test-ffmpeg.js";

// Issue #491: the specs' fixture runner, which a stuck ffmpeg mustn't turn
// into a check job that never ends.

const bun = process.execPath;

describe("the specs' fixture runner", () => {
  it("gives the child no stdin, or only the bytes it's handed", () => {
    const echo = ["-e", "process.stdout.write(JSON.stringify(await Bun.stdin.text()))"];
    expect(runTool(bun, echo).toString()).toBe('""');
    expect(runTool(bun, echo, { input: Buffer.from("bytes") }).toString()).toBe('"bytes"');
  });

  it("kills a child that ignores SIGTERM once its timeout passes, and names the command", () => {
    const stuck = ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'];
    const started = Date.now();
    expect(() => tryTool(bun, stuck, { timeoutMs: 300 })).toThrow(`${bun} -e ${JSON.stringify(stuck[1])} timed out after 300 ms`);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("fails with the command, its exit status and what it printed", () => {
    expect(() => runTool(bun, ["-e", 'console.error("no such tone"); process.exit(3)'])).toThrow(/ exited with 3:\nno such tone$/);
  });

  it("never leaves ffmpeg asking whether to overwrite", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "legato-test-ffmpeg-"));
    try {
      const existing = path.join(dir, "tone.flac");
      writeFileSync(existing, "");
      // ffmpeg counts declining to overwrite as a clean exit, so it's what
      // it printed that says it never asked.
      const result = tryFfmpeg(["-f", "lavfi", "-i", "sine=duration=0.1", existing], { timeoutMs: 3_000 });
      expect(result.stderr).toContain("already exists. Exiting.");
      expect(result.stderr).not.toContain("Overwrite?");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
