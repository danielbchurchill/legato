import { spawn } from "node:child_process";

let fpcalcMissingWarned = false;

// Local Chromaprint fingerprint only — used to detect "these two local
// files are acoustically the same recording" (tier 2's self-referential
// grouping). Cross-referencing a fingerprint against the AcoustID web
// service to resolve a MusicBrainz recording id is M7's job, not this.
//
// fpcalc is an optional system binary, not an npm dependency — must never
// crash the scan if it's missing, same lesson as chokidar's lost+found
// EACCES: an external tool's absence degrades a feature, it doesn't take
// the server down.
export async function computeFingerprint(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("fpcalc", ["-plain", filePath]);
    let stdout = "";
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" && !fpcalcMissingWarned) {
        fpcalcMissingWarned = true;
        console.warn(
          "[fingerprint] fpcalc not found on PATH — tier 2 (acoustic) matching is disabled. " +
            "Install it (e.g. `apt install libchromaprint-tools`) to enable it.",
        );
      }
      finish(null);
    });

    proc.on("close", (code) => {
      finish(code === 0 ? stdout.trim() || null : null);
    });
  });
}
