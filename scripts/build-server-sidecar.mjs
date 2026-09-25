#!/usr/bin/env node
// Compiles the server (#102's `bun build --compile`, via
// server/scripts/compile.ts) for this machine's own Rust target triple and
// places the result at src-tauri/binaries/legato-server-<target-triple>
// (`.exe` on Windows) — the exact name Tauri's `externalBin` bundling step
// (tauri.conf.json's bundle.externalBin) expects to find at `tauri build`
// time. Wired into tauri.conf.json's beforeBuildCommand, so a plain
// `npx tauri build` produces a packaged app that needs no Node/Bun/npm on
// the machine it runs on — see src-tauri/src/server_process.rs's
// resolve_sidecar_binary and issue #103.
//
// Only ever targets the *host's own* triple — cross-compiling all five of
// #102's release targets from one machine for a multi-platform release is
// the release workflow's job (once it exists), not a local package build's.
//
// Run: node scripts/build-server-sidecar.mjs   (or `npm run build:sidecar`)
//
// --if-missing: skip compiling if the destination file already exists.
// tauri.conf.json's beforeDevCommand passes this — `tauri-build`'s build
// script validates every bundle.externalBin path exists on *every* cargo
// build, dev included (confirmed by reading tauri-build's source; it's not
// gated on `tauri::is_dev()` the way this repo's own use of the sidecar
// is), so `npx tauri dev` needs a real file here even though
// src-tauri/src/server_process.rs never actually spawns it outside a
// packaged build. Rebuilding on every dev launch would still work but
// wastes a compile nobody asked for; beforeBuildCommand omits the flag so
// packaging always ships a fresh binary.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const OUT_DIR = path.join(REPO_ROOT, "src-tauri", "binaries");

// Mirrors src-tauri/src/server_process.rs's TARGET_TRIPLE and
// scripts/fetch-media-binaries.mjs's platform scope: macOS + Windows only,
// per CLAUDE.md's M10 note that Linux desktop packaging isn't part of this
// pass (Linux keeps relying on a system-installed server/toolchain).
const RUST_TRIPLE = {
  "darwin:arm64": "aarch64-apple-darwin",
  "darwin:x64": "x86_64-apple-darwin",
  "win32:x64": "x86_64-pc-windows-msvc",
};

// Keys match server/scripts/compile.ts's TARGETS map.
const COMPILE_TARGET = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64-baseline",
  "x86_64-pc-windows-msvc": "windows-x64-baseline",
};

function hostTriple() {
  const key = `${process.platform}:${process.arch}`;
  const triple = RUST_TRIPLE[key];
  if (!triple) {
    throw new Error(
      `no server sidecar target mapped for ${key} — this repo only packages the desktop app for macOS and Windows today (see CLAUDE.md's M10 note)`,
    );
  }
  return triple;
}

async function main() {
  const ifMissing = process.argv.includes("--if-missing");
  const triple = hostTriple();
  const compileTarget = COMPILE_TARGET[triple];
  const exeSuffix = triple.includes("windows") ? ".exe" : "";
  const dest = path.join(OUT_DIR, `legato-server-${triple}${exeSuffix}`);

  if (ifMissing && existsSync(dest)) {
    console.log(`sidecar already built at ${path.relative(REPO_ROOT, dest)} — skipping (delete it, or omit --if-missing, to force a rebuild)`);
    return;
  }

  console.log(`building legato-server sidecar for ${triple} (server compile target: ${compileTarget})`);
  const result = spawnSync("npm", ["--prefix", "server", "run", "compile", "--", compileTarget], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  if (result.status !== 0) {
    throw new Error(`server compile failed for ${compileTarget} (exit ${result.status})`);
  }

  const compiled = path.join(SERVER_DIR, "dist", compileTarget, `legato-server${exeSuffix}`);
  if (!existsSync(compiled)) {
    throw new Error(`expected ${compiled} to exist after a successful compile, but it doesn't`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await copyFile(compiled, dest);
  await chmod(dest, 0o755);

  console.log(`-> ${path.relative(REPO_ROOT, dest)}`);
}

main().catch((err) => {
  console.error(`\nbuild-server-sidecar failed: ${err.message}`);
  process.exit(1);
});
