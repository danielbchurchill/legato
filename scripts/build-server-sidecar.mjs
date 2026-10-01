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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const OUT_DIR = path.join(REPO_ROOT, "src-tauri", "binaries");

// Covers exactly the five release targets server/scripts/compile.ts's own
// TARGETS map supports — every platform this repo can actually produce a
// server binary for is mapped here, deliberately not a subset. Linux x64 and
// arm64 are the main development and home-server platforms, so they're the
// platforms this sidecar matters most for, not an also-ran next to macOS and
// Windows — see issue #103's follow-up. macOS/Windows *packaging verification* may be
// deferred; Linux was never scoped out of the sidecar itself.
const RUST_TRIPLE = {
  "darwin:arm64": "aarch64-apple-darwin",
  "darwin:x64": "x86_64-apple-darwin",
  "win32:x64": "x86_64-pc-windows-msvc",
  "linux:x64": "x86_64-unknown-linux-gnu",
  "linux:arm64": "aarch64-unknown-linux-gnu",
};

// Keys match server/scripts/compile.ts's TARGETS map.
const COMPILE_TARGET = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64-baseline",
  "x86_64-pc-windows-msvc": "windows-x64-baseline",
  "x86_64-unknown-linux-gnu": "linux-x64-baseline",
  "aarch64-unknown-linux-gnu": "linux-arm64",
};

// The Bun release the server is built and tested against — the same version
// .github/workflows/check.yml and release.yml pin via setup-bun. Bump all
// three together.
const BUN_VERSION = "1.4.2";

// `npm --prefix server run compile` shells out to `bun`, and when it's missing
// the only thing that surfaces is the shell's own `sh: 1: bun: not found`
// (issue #187, first hit on the AIO) — nothing about why a desktop build
// needs Bun, which version, or where to get it. Checking up front turns that
// into an error someone can act on. A different version only warns: a
// nearby Bun usually compiles fine, and refusing to build over a patch
// release would be worse than the mismatch itself.
function checkBun() {
  const onWindows = process.platform === "win32";
  const installCommand = onWindows
    ? `iex "& {$(irm https://bun.sh/install.ps1)} -Version ${BUN_VERSION}"   (in PowerShell)`
    : `curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"`;

  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    const bunHome = path.join(os.homedir(), ".bun", "bin");
    const pathHint = onWindows
      ? `add ${bunHome} to your user PATH (System Properties → Environment Variables), then open a new terminal`
      : `export PATH="${bunHome}:$PATH"   (and add that line to your shell profile)`;
    // The official installer drops Bun in ~/.bun/bin and only *offers* to edit
    // the shell profile, so "installed but not on PATH" is the likeliest case
    // on a machine that has built the server before — say so first when true.
    const alreadyInstalled = existsSync(path.join(bunHome, onWindows ? "bun.exe" : "bun"));
    const lines = [
      `the server sidecar needs Bun ${BUN_VERSION} to compile, and \`bun --version\` failed (${probe.error ? probe.error.code : `exit ${probe.status}`}).`,
      alreadyInstalled
        ? `Bun is already installed at ${bunHome} but isn't on PATH — add it:\n    ${pathHint}`
        : `Install it with:\n    ${installCommand}\n  If Bun is already installed under ${bunHome}, it just needs adding to PATH:\n    ${pathHint}`,
      `Then re-run the build.`,
    ];
    throw new Error(lines.join("\n  "));
  }

  const found = probe.stdout.trim();
  if (found !== BUN_VERSION) {
    console.warn(
      `warning: found Bun ${found}, but the server is built and tested against ${BUN_VERSION} — continuing, but if the compile misbehaves, install the pinned version:\n    ${installCommand}`,
    );
  }
}

function hostTriple() {
  const key = `${process.platform}:${process.arch}`;
  const triple = RUST_TRIPLE[key];
  if (!triple) {
    // RUST_TRIPLE already covers every target server/scripts/compile.ts
    // knows how to build (see comment above) — a miss here means a genuinely
    // unsupported platform, one no server binary could be compiled for
    // either way. Failing fast with that explanation, before cargo ever
    // runs, beats letting tauri-build's own build.rs fail later with an
    // opaque "resource path ... doesn't exist": same outcome (`npx tauri
    // dev` can't succeed on a platform with no server build), but this is
    // the clearer place to learn why.
    throw new Error(
      `no server sidecar target mapped for ${key} — server/scripts/compile.ts has no build for this platform either, so there's no binary this script could produce`,
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

  // After the --if-missing skip on purpose: `npx tauri dev` on a machine that
  // already has the sidecar shouldn't start needing Bun on PATH just to
  // confirm a file exists.
  checkBun();

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
