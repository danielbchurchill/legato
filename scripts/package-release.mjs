#!/usr/bin/env node
// Packages server/dist/<target>/ (legato-server + ffmpeg + fpcalc — see
// server/scripts/compile.ts and scripts/fetch-release-media-binaries.mjs,
// both of which must have already run) into the per-target archives
// .github/workflows/release.yml publishes, plus one SHA256SUMS covering
// all of them — the shape issue #102 asks for: legato-server-<version>-<target>.tar.gz (.zip for
// Windows), each archive holding a single legato-server-<version>-<target>/
// directory so extracting it into a shared downloads folder can't clobber
// another target's files of the same name.
//
// Run: node scripts/package-release.mjs <version> [target...]
// No targets given -> packages all five. Output: dist-release/ at the repo
// root (gitignored, same as any other build output).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_DIST = path.join(REPO_ROOT, "server", "dist");
const OUT_DIR = path.join(REPO_ROOT, "dist-release");

const RELEASE_TARGETS = ["linux-x64-baseline", "linux-arm64", "darwin-arm64", "darwin-x64-baseline", "windows-x64-baseline"];
const WINDOWS_TARGETS = new Set(["windows-x64-baseline"]);

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function packageTarget(version, target) {
  const srcDir = path.join(SERVER_DIST, target);
  if (!existsSync(srcDir)) {
    throw new Error(`${srcDir} doesn't exist — run \`npm --prefix server run compile -- ${target}\` and fetch-release-media-binaries.mjs first`);
  }

  const isWindows = WINDOWS_TARGETS.has(target);
  const binaryName = isWindows ? "legato-server.exe" : "legato-server";
  const requiredFiles = [binaryName, isWindows ? "ffmpeg.exe" : "ffmpeg", isWindows ? "fpcalc.exe" : "fpcalc"];
  const entries = await readdir(srcDir);
  for (const f of requiredFiles) {
    if (!entries.includes(f)) throw new Error(`${srcDir} is missing ${f} — did compile.ts and fetch-release-media-binaries.mjs both run for ${target}?`);
  }

  const stem = `legato-server-${version}-${target}`;
  const stagingDir = path.join(OUT_DIR, "staging", stem);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  // Copy rather than move: server/dist/<target>/ is also compile.ts's own
  // output location, and re-running this script shouldn't require
  // re-fetching/re-compiling.
  const cp = spawnSync("cp", ["-p", ...requiredFiles.map((f) => path.join(srcDir, f)), stagingDir], { stdio: "inherit" });
  if (cp.status !== 0) throw new Error(`cp failed staging ${target}`);

  await mkdir(OUT_DIR, { recursive: true });
  const archiveName = isWindows ? `${stem}.zip` : `${stem}.tar.gz`;
  const archivePath = path.join(OUT_DIR, archiveName);

  if (isWindows) {
    const r = spawnSync("zip", ["-r", "-q", archivePath, stem], { cwd: path.join(OUT_DIR, "staging"), stdio: "inherit" });
    if (r.status !== 0) throw new Error(`zip failed for ${target}`);
  } else {
    const r = spawnSync("tar", ["-czf", archivePath, stem], { cwd: path.join(OUT_DIR, "staging"), stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar failed for ${target}`);
  }

  return { archiveName, archivePath };
}

async function main() {
  const [version, ...rest] = process.argv.slice(2);
  if (!version) {
    console.error("usage: node scripts/package-release.mjs <version> [target...]");
    process.exit(1);
  }
  const targets = rest.length > 0 ? rest : RELEASE_TARGETS;
  for (const t of targets) {
    if (!RELEASE_TARGETS.includes(t)) throw new Error(`unknown target "${t}" — expected one of: ${RELEASE_TARGETS.join(", ")}`);
  }

  const checksums = [];
  for (const target of targets) {
    console.log(`packaging ${target}...`);
    const { archiveName, archivePath } = await packageTarget(version, target);
    const sha256 = await sha256File(archivePath);
    checksums.push(`${sha256}  ${archiveName}`);
    console.log(`  -> dist-release/${archiveName}`);
  }

  const sumsPath = path.join(OUT_DIR, "SHA256SUMS");
  await writeFile(sumsPath, checksums.join("\n") + "\n");
  console.log(`\nwrote ${path.relative(REPO_ROOT, sumsPath)}:`);
  console.log(checksums.map((l) => `  ${l}`).join("\n"));
}

main().catch((err) => {
  console.error(`\npackage-release failed: ${err.message}`);
  process.exit(1);
});
