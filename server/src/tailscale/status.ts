import { execFile } from "node:child_process";
import { TAILSCALE_COMMANDS } from "../config.js";
import type { TailscaleStatus } from "./where.js";

/* Issue #412: `tailscale status --json`, from the CLI config.ts resolves.
 * It asks this machine's tailscaled over its local socket, so it's no
 * network contact. Each command in `commands` is tried in turn while the
 * one before it isn't there; the first that runs is kept. */

// A wedged tailscaled can't hold up the answer for long.
const STATUS_TIMEOUT_MS = 5_000;
// A tailnet with thousands of peers still fits.
const STATUS_MAX_BUFFER = 32 * 1024 * 1024;

export type ReadTailscaleStatus = () => Promise<TailscaleStatus>;

type ExecFile = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void,
) => unknown;

export function tailscaleStatusReader(
  commands: readonly string[] = TAILSCALE_COMMANDS,
  run: ExecFile = execFile as unknown as ExecFile,
): ReadTailscaleStatus {
  let remaining = [...commands];

  const attempt = (command: string): Promise<TailscaleStatus> =>
    new Promise((resolve, reject) => {
      run(
        command,
        ["status", "--json"],
        { timeout: STATUS_TIMEOUT_MS, maxBuffer: STATUS_MAX_BUFFER, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            // Not there at all, as opposed to there and failing.
            if (error.code === "ENOENT") return reject(Object.assign(new Error(`${command} not found`), { missing: true }));
            const why =
              String(stderr ?? "")
                .trim()
                .split("\n")[0] || error.message;
            return reject(new Error(`${command} status --json failed: ${why}`));
          }
          try {
            resolve(JSON.parse(stdout) as TailscaleStatus);
          } catch {
            reject(new Error(`${command} status --json printed something that isn't JSON`));
          }
        },
      );
    });

  return async function readTailscaleStatus() {
    for (;;) {
      const command = remaining[0];
      if (command === undefined) throw new Error("no tailscale CLI to run");
      try {
        const status = await attempt(command);
        remaining = [command];
        return status;
      } catch (error) {
        if (!(error as { missing?: boolean }).missing) throw error;
        // The next candidate, unless this was the last.
        if (remaining.length > 1) {
          remaining = remaining.slice(1);
          continue;
        }
        // None is there. The next read tries them all again, in case one
        // has been installed since.
        remaining = [...commands];
        throw new Error(`no tailscale CLI found (tried ${commands.join(", ")})`);
      }
    }
  };
}
