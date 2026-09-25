#!/usr/bin/env bun
// Compiles server/src/index.ts into a standalone Bun executable for one or
// more of issue #102's five release targets, via `Bun.build`'s `compile`
// option (bun build --compile under the hood, called as a JS API instead
// of shelled out to so build results/errors come back structured rather
// than as text to re-parse).
//
// Usage (run from server/, matches the "compile" npm script):
//   bun scripts/compile.ts [target...]
//   npm run compile -- linux-x64-baseline darwin-arm64
// No targets given -> builds all five. Output lands in server/dist/<target>/
// as legato-server (legato-server.exe on Windows).
//
// LEGATO_RELEASE_VERSION / LEGATO_RELEASE_GIT_SHA let the release workflow
// pin exact values (the git tag, the tagged commit's SHA) instead of this
// script re-deriving them — see .github/workflows/release.yml. Local runs
// fall back to package.json's version and `git rev-parse --short HEAD`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { generateMigrationsManifest } from "./generate-migrations-manifest.mjs";

const SERVER_DIR = path.join(import.meta.dirname, "..");
const DIST_DIR = path.join(SERVER_DIR, "dist");

// bunTarget: the string bun build --compile --target=<val> expects.
// windows produces a .exe regardless of the outfile extension given, so
// that's tracked separately rather than guessed from the target name.
const TARGETS: Record<string, { bunTarget: Bun.Build.CompileTarget; windows: boolean }> = {
  "linux-x64-baseline": { bunTarget: "bun-linux-x64-baseline", windows: false },
  "linux-arm64": { bunTarget: "bun-linux-arm64", windows: false },
  "darwin-arm64": { bunTarget: "bun-darwin-arm64", windows: false },
  "darwin-x64-baseline": { bunTarget: "bun-darwin-x64-baseline", windows: false },
  "windows-x64-baseline": { bunTarget: "bun-windows-x64-baseline", windows: true },
};

function resolveVersion(): string {
  if (process.env.LEGATO_RELEASE_VERSION) return process.env.LEGATO_RELEASE_VERSION;
  const pkg = JSON.parse(readFileSync(path.join(SERVER_DIR, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

function resolveGitSha(): string {
  if (process.env.LEGATO_RELEASE_GIT_SHA) return process.env.LEGATO_RELEASE_GIT_SHA;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: SERVER_DIR, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

async function compileTarget(name: string, version: string, gitSha: string): Promise<{ name: string; outFile: string; bytes: number }> {
  const target = TARGETS[name];
  if (!target) {
    throw new Error(`unknown target "${name}" — expected one of: ${Object.keys(TARGETS).join(", ")}`);
  }

  const outDir = path.join(DIST_DIR, name);
  mkdirSync(outDir, { recursive: true });
  // Passed without an extension — bun build appends .exe itself on Windows
  // targets (confirmed by hand: --outfile=foo on a windows target produces
  // foo.exe, not foo), so the extension is detected after the fact below
  // rather than assumed here.
  const outfileBase = path.join(outDir, "legato-server");

  const result = await Bun.build({
    entrypoints: [path.join(SERVER_DIR, "src", "index.ts")],
    target: "bun",
    define: {
      __LEGATO_VERSION__: JSON.stringify(version),
      __LEGATO_GIT_SHA__: JSON.stringify(gitSha),
    },
    compile: {
      target: target.bunTarget,
      outfile: outfileBase,
    },
  });

  if (!result.success) {
    const messages = result.logs.map((l) => l.message).join("\n");
    throw new Error(`build failed for ${name}:\n${messages}`);
  }

  const produced = target.windows ? `${outfileBase}.exe` : outfileBase;
  if (!existsSync(produced)) {
    throw new Error(`expected ${produced} to exist after a successful build for ${name}, but it doesn't`);
  }

  // Normalize to a stable name regardless of platform so the release
  // workflow's archiving step doesn't need per-OS branching to find it.
  const finalName = target.windows ? "legato-server.exe" : "legato-server";
  const finalPath = path.join(outDir, finalName);
  if (produced !== finalPath) renameSync(produced, finalPath);

  return { name, outFile: finalPath, bytes: statSync(finalPath).size };
}

async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length > 0 ? requested : Object.keys(TARGETS);

  const { count } = generateMigrationsManifest();
  console.log(`migrations manifest: ${count} files embedded\n`);

  const version = resolveVersion();
  const gitSha = resolveGitSha();
  console.log(`version: ${version} (${gitSha})\n`);

  const results: { name: string; outFile: string; bytes: number }[] = [];
  for (const name of targets) {
    console.log(`compiling ${name}...`);
    const result = await compileTarget(name, version, gitSha);
    console.log(`  -> ${path.relative(SERVER_DIR, result.outFile)} (${formatBytes(result.bytes)})`);
    results.push(result);
  }

  console.log("\nDone:");
  for (const r of results) {
    console.log(`  ${r.name.padEnd(24)} ${formatBytes(r.bytes).padStart(10)}  ${path.relative(SERVER_DIR, r.outFile)}`);
  }
}

main().catch((err) => {
  console.error(`\ncompile failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
