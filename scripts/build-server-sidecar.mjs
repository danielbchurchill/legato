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
// Targets the host's own triple unless told otherwise. `--target <triple>`,
// or the TAURI_ENV_TARGET_TRIPLE the Tauri CLI sets for beforeBuildCommand
// under `tauri build --target`, picks another: the desktop release builds
// the Intel Mac app on an Apple Silicon runner (#129, desktop.yml), and Bun
// cross-compiles the server for it.
//
// Run: node scripts/build-server-sidecar.mjs [--target <triple>]
//      (or `npm run build:sidecar`)
//
// --if-missing: skip compiling if the destination file already exists and
// was compiled by the pinned Bun (see staleSidecar below).
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

// The Bun release the server is built and tested against. The workflows'
// setup-bun steps, server/Dockerfile and the docs pin the same version; bump
// them together (`grep -rn` for the old version finds every one). The
// relay's image moves on its own (relay/Dockerfile).
const BUN_VERSION = "1.4.4";

function installCommand() {
  return process.platform === "win32"
    ? `iex "& {$(irm https://bun.sh/install.ps1)} -Version ${BUN_VERSION}"   (in PowerShell)`
    : `curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"`;
}

function probeBun() {
  return spawnSync("bun", ["--version"], { encoding: "utf8" });
}

// `npm --prefix server run compile` shells out to `bun`, and when it's missing
// the only thing that surfaces is the shell's own `sh: 1: bun: not found`
// (issue #187, first hit on the AIO) — nothing about why a desktop build
// needs Bun, which version, or where to get it. Checking up front turns that
// into an error someone can act on. A different version only warns: a
// nearby Bun usually compiles fine, and refusing to build over a patch
// release would be worse than the mismatch itself.
function checkBun() {
  const onWindows = process.platform === "win32";
  const probe = probeBun();
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
        : `Install it with:\n    ${installCommand()}\n  If Bun is already installed under ${bunHome}, it just needs adding to PATH:\n    ${pathHint}`,
      `Then re-run the build.`,
    ];
    throw new Error(lines.join("\n  "));
  }

  const found = probe.stdout.trim();
  if (found !== BUN_VERSION) {
    console.warn(
      `warning: found Bun ${found}, but the server is built and tested against ${BUN_VERSION} — continuing, but if the compile misbehaves, install the pinned version:\n    ${installCommand()}`,
    );
  }
}

// Whether --if-missing should rebuild a sidecar that's already there. A pin
// moves for a reason (#491: Bun 1.4.2's spawnSync could lose a child's
// exit), and without this a sidecar compiled before the move would stay for
// good. Run with BUN_BE_BUN=1, a compiled binary acts as the Bun that
// compiled it, so `--version` names that Bun, with no stamp file in
// binaries/, which the bundle copies whole. Returns why to rebuild, or null
// to keep the file: kept when the pinned Bun built it, when it can't say (a
// --target build for another platform doesn't run here), and when the Bun
// on PATH built it or there's none, since a rebuild would change nothing.
function staleSidecar(dest) {
  const probe = spawnSync(dest, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  const builtWith = probe.status === 0 ? probe.stdout.trim() : "";
  if (!/^\d+\.\d+\.\d+$/.test(builtWith) || builtWith === BUN_VERSION) return null;

  const onPath = probeBun();
  const found = onPath.error || onPath.status !== 0 ? null : onPath.stdout.trim();
  if (found === null || found === builtWith) {
    console.warn(
      `warning: the sidecar at ${path.relative(REPO_ROOT, dest)} was compiled by Bun ${builtWith}, not ${BUN_VERSION}. Keeping it: ${found ? `the Bun on PATH is ${found} too` : "there's no bun on PATH"}. Install Bun ${BUN_VERSION} and the next run rebuilds it:\n    ${installCommand()}`,
    );
    return null;
  }
  return `it was compiled by Bun ${builtWith}, not ${BUN_VERSION}`;
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

// --target wins, then the Tauri CLI's target, then this machine's own.
function targetTriple() {
  const flag = process.argv.indexOf("--target");
  const requested = flag === -1 ? process.env.TAURI_ENV_TARGET_TRIPLE : process.argv[flag + 1];
  if (!requested) return hostTriple();
  if (!COMPILE_TARGET[requested]) {
    throw new Error(`no server sidecar target for ${requested}; the ones a server binary is built for are ${Object.keys(COMPILE_TARGET).join(", ")}`);
  }
  return requested;
}

async function main() {
  const ifMissing = process.argv.includes("--if-missing");
  const triple = targetTriple();
  const compileTarget = COMPILE_TARGET[triple];
  const exeSuffix = triple.includes("windows") ? ".exe" : "";
  const dest = path.join(OUT_DIR, `legato-server-${triple}${exeSuffix}`);

  if (ifMissing && existsSync(dest)) {
    const stale = staleSidecar(dest);
    if (!stale) {
      console.log(`sidecar already built at ${path.relative(REPO_ROOT, dest)} — skipping (delete it, or omit --if-missing, to force a rebuild)`);
      return;
    }
    console.log(`rebuilding the sidecar at ${path.relative(REPO_ROOT, dest)}: ${stale}`);
  }

  // After the --if-missing skip on purpose: `npx tauri dev` on a machine that
  // already has the sidecar shouldn't start needing Bun on PATH just to
  // confirm a file exists.
  checkBun();

  console.log(`building legato-server sidecar for ${triple} (server compile target: ${compileTarget})`);
  // On Windows `npm` is npm.cmd, and Node refuses to spawn a .cmd without a
  // shell (CVE-2024-27980), so without one the spawn fails before npm runs.
  // Every argument here is a fixed string or a known compile target, so the
  // shell has nothing to interpret.
  const result = spawnSync("npm", ["--prefix", "server", "run", "compile", "--", compileTarget], {
    stdio: "inherit",
    cwd: REPO_ROOT,
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw new Error(`couldn't run the server compile for ${compileTarget}: ${result.error.message}`);
  }
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
