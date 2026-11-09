// Test-only: runs ffmpeg and ffprobe for the specs' fixtures, and to read
// back what they made. Not a *.spec.ts, so `bun test` never runs it as a
// suite of its own.
//
// Issue #491: specs blocked in spawnSync held the check job until someone
// cancelled it. The cause was Bun's, not ffmpeg's. On Bun 1.4.2, a garbage
// collection during one spawnSync could leave a later one waiting for ever
// on a child that had already exited (oven-sh/bun#34069, fixed in 1.4.3).
// It struck under `bun test --isolate`, in a spec that spawns only `bun -e`
// as well as in ones that spawn ffmpeg, and the timeout below never fired.
// The server is on a Bun with the fix.
//
// The rest still holds for a child that really does stall. When a test or
// hook times out, bun test kills the child it's waiting on with that
// spawn's killSignal, SIGTERM unless told otherwise, and ffmpeg catches
// SIGTERM to finish its output. So every run here:
//
// - gives the child no stdin, only the bytes it's handed if there are any,
//   and passes ffmpeg -nostdin, so nothing waits on a keyboard or on an
//   "Overwrite? [y/N]" prompt;
// - is killed with SIGKILL, which can't be caught, whether by bun's timeout
//   or by its own;
// - has a timeout of its own, for a spawn outside any test's (at a module's
//   top level, or in a test with a long one);
// - fails with the command it ran, how it ended, and what it printed.
import { spawnSync } from "node:child_process";
import { FFMPEG_PATH } from "./mediaBinaries.js";

// Many times what the slowest fixture here takes (twenty minutes of FLAC,
// about a second), and still short enough to fail a stuck run promptly.
export const TOOL_TIMEOUT_MS = 30_000;

export interface ToolOptions {
  /** Bytes for the child's stdin. Without them it has none. */
  input?: Buffer;
  timeoutMs?: number;
}

export interface ToolResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

/** Runs a command and says how it exited. Throws only if it couldn't
 *  start, timed out or was killed: a non-zero exit is the caller's to judge. */
export function tryTool(command: string, args: readonly string[], options: ToolOptions = {}): ToolResult {
  const timeout = options.timeoutMs ?? TOOL_TIMEOUT_MS;
  const result = spawnSync(command, args, {
    input: options.input,
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
  });
  const stderr = result.stderr?.toString().trim() ?? "";
  if (result.status === null) {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const how = timedOut
      ? `timed out after ${timeout} ms`
      : result.signal
        ? `was killed by ${result.signal}`
        : `couldn't run: ${result.error?.message}`;
    throw new Error(describe(command, args, how, stderr));
  }
  return { status: result.status, stdout: result.stdout, stderr };
}

/** Runs a command and returns its stdout. Throws unless it exits 0. */
export function runTool(command: string, args: readonly string[], options: ToolOptions = {}): Buffer {
  const result = tryTool(command, args, options);
  if (result.status !== 0) throw new Error(describe(command, args, `exited with ${result.status}`, result.stderr));
  return result.stdout;
}

const FFMPEG_ARGS = ["-nostdin", "-hide_banner", "-loglevel", "error"];

/** ffmpeg, as the server finds it, run as above. */
export function runFfmpeg(args: readonly string[], options?: ToolOptions): Buffer {
  return runTool(FFMPEG_PATH, [...FFMPEG_ARGS, ...args], options);
}

/** ffmpeg as above, for a spec that expects some runs to fail. */
export function tryFfmpeg(args: readonly string[], options?: ToolOptions): ToolResult {
  return tryTool(FFMPEG_PATH, [...FFMPEG_ARGS, ...args], options);
}

/** ffprobe, which has no -nostdin and no stdin to read here either. */
export function runFfprobe(args: readonly string[], options?: ToolOptions): Buffer {
  return runTool("ffprobe", args, options);
}

function describe(command: string, args: readonly string[], how: string, stderr: string): string {
  const ran = [command, ...args].map((arg) => (/^[\w./:=,@+-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");
  return `${ran} ${how}${stderr ? `:\n${stderr}` : ""}`;
}
