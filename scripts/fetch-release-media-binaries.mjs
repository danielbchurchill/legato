#!/usr/bin/env node
// Downloads real ffmpeg + fpcalc (Chromaprint) binaries for issue #102's
// five *server* release targets, into server/dist/<target>/ alongside the
// compiled legato-server binary scripts/compile.ts already puts there —
// so the release workflow (.github/workflows/release.yml) can archive
// each server/dist/<target>/ directory as-is.
//
// This is a sibling to fetch-media-binaries.mjs, not a replacement for it:
// that script feeds the Tauri desktop sidecar (src-tauri/binaries/,
// macOS + Windows only — Linux relies on system ffmpeg there per
// AGENTS.md) and stays exactly as it is. This one is server-release-only,
// covers all five compile targets including both Linux ones (a headless
// install from the install script, #108, has no apt/system ffmpeg
// guarantee the way the Docker image does), and writes to a different destination. Some sources overlap
// (osxexperts.net, gyan.dev, chromaprint's GitHub releases)
// but each fetch here is independent so neither script can break the
// other by being edited.
//
// Run: node scripts/fetch-release-media-binaries.mjs [target...]
// No targets given -> fetches for all five. Requires unzip, tar, and xz
// (via tar -J) on PATH.
//
// ---------------------------------------------------------------------------
// Sources:
//
// ffmpeg / darwin-arm64 — osxexperts.net, same as fetch-media-binaries.mjs
//   (see that file's header for why: no arm64 build from ffmpeg.org or
//   evermeet.cx exists). sha256-checked against a pinned reference, soft
//   warning only on mismatch — this source's URL is unversioned and drifts.
//
// ffmpeg / darwin-x64-baseline — osxexperts.net's Intel build
//   (ffmpeg80intel.zip, ffmpeg 8.0), sha256-checked against the hash the
//   site publishes for the extracted binary, which is pinned below and was
//   matched by hand on 2026-10-12. Unlike the arm64 build, a mismatch here
//   fails the release: this URL names its version, so a different hash
//   means a different file, not a newer build.
//   It was evermeet.cx, GPG-signed, as fetch-media-binaries.mjs still uses
//   for local packaging. The first v0.1.0 release run failed three times on
//   it: evermeet.cx redirects downloads to a mirror that answers a second
//   request from the same address with HTTP 429 for minutes on end, and the
//   signature is always the second request. A release runner can't wait
//   that out, so the release takes the source it can rely on.
//
// ffmpeg / windows-x64-baseline — gyan.dev's release-essentials build,
//   sha256-checked against its own published checksum, same as
//   fetch-media-binaries.mjs.
//
// ffmpeg / linux-x64-baseline, linux-arm64 — johnvansickle.com
//   (https://johnvansickle.com/ffmpeg/), the static-build source ffmpeg's
//   own community widely points to for Linux (no official ffmpeg.org
//   Linux binaries exist — Linux is normally a distro-package install,
//   which is exactly what a static binary here is standing in for).
//   md5-checked against the checksum it publishes alongside each archive.
//
// fpcalc (Chromaprint), all five targets — chromaprint's own GitHub
//   releases, same source and same "record, don't fail" approach (no
//   official checksums published) as fetch-media-binaries.mjs.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "server", "dist");


// Same reference hash and same reasoning as fetch-media-binaries.mjs — see
// that file's header comment for how/when this was captured.
const OSXEXPERTS_FFMPEG_ARM64_URL = "https://www.osxexperts.net/ffmpeg9arm.zip";
const OSXEXPERTS_FFMPEG_ARM64_SHA256 = "591260c945d0eef150e3bf82b0ef988bd36a9cecc18ff05d6679617159f0a95e";
// The hash osxexperts.net publishes for ffmpeg80intel.zip's extracted
// binary, matched against a real download on 2026-10-12.
const OSXEXPERTS_FFMPEG_X64_URL = "https://www.osxexperts.net/ffmpeg80intel.zip";
const OSXEXPERTS_FFMPEG_X64_SHA256 = "df3f1e3facdc1ae0ad0bd898cdfb072fbc9641bf47b11f172844525a05db8d11";

const RELEASE_TARGETS = ["linux-x64-baseline", "linux-arm64", "darwin-arm64", "darwin-x64-baseline", "windows-x64-baseline"];
const WINDOWS_TARGETS = new Set(["windows-x64-baseline"]);
const exeSuffix = (target) => (WINDOWS_TARGETS.has(target) ? ".exe" : "");

// The release's first run (v0.1.0) died on one HTTP 429 from evermeet.cx:
// these hosts rate-limit GitHub's shared runner addresses, and a single
// refusal used to fail the whole release. A 429 or a 5xx is retried up to
// four more times, waiting as long as Retry-After asks (capped at a minute)
// or 5, 15, 30 and 60 seconds; anything else fails at once, as before.
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

async function fetchWithRetry(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= RETRY_DELAYS_MS.length) return res;
    const asked = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked * 1000, 60_000) : RETRY_DELAYS_MS[attempt];
    console.log(`  [retry] GET ${url} -> HTTP ${res.status}; trying again in ${Math.round(waitMs / 1000)} s`);
    await res.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function download(url, destPath) {
  const res = await fetchWithRetry(url);
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  await mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

async function fetchText(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

async function hashFile(algo, filePath) {
  const hash = createHash(algo);
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function extractArchive(archivePath, destDir) {
  await mkdir(destDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    const r = spawnSync("unzip", ["-o", "-q", archivePath, "-d", destDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`unzip failed for ${archivePath}`);
  } else if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    const r = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar failed for ${archivePath}`);
  } else if (archivePath.endsWith(".tar.xz")) {
    const r = spawnSync("tar", ["-xJf", archivePath, "-C", destDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar failed for ${archivePath}`);
  } else {
    throw new Error(`don't know how to extract ${archivePath}`);
  }
}

// Every archive here nests its binary under a version/platform-named
// folder that changes release to release — see fetch-media-binaries.mjs's
// identical helper for why this searches by basename instead.
async function findFile(root, basename) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "__MACOSX") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(full, basename);
      if (found) return found;
    } else if (entry.name === basename) {
      return full;
    }
  }
  return null;
}

async function fetchFfmpegOsxExperts(workDir, { url, sha256, strict }) {
  console.log("  source: osxexperts.net (community, sha256-checked)");
  console.log(`  fetching ${url}`);
  const zipPath = path.join(workDir, "ffmpeg-osxexperts.zip");
  await download(url, zipPath);
  const extractDir = path.join(workDir, "extracted");
  await extractArchive(zipPath, extractDir);
  const bin = await findFile(extractDir, "ffmpeg");
  if (!bin) throw new Error("osxexperts.net zip did not contain an 'ffmpeg' binary");
  const actual = await hashFile("sha256", bin);
  if (actual === sha256) {
    console.log("  [ok] sha256 matches the reference");
  } else if (strict) {
    throw new Error(`${url}: the extracted ffmpeg's sha256 is ${actual}, not the published ${sha256}`);
  } else {
    console.warn(`  [warn] sha256 mismatch against the pinned reference — osxexperts.net's unversioned URL likely shipped a newer build.`);
  }
  return bin;
}

async function fetchFfmpegGyan(workDir) {
  console.log("  source: gyan.dev (official Windows build, sha256-checked)");
  const zipUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
  const zipPath = path.join(workDir, "ffmpeg-gyan.zip");
  await download(zipUrl, zipPath);
  const expected = (await fetchText(`${zipUrl}.sha256`)).trim().split(/\s+/)[0];
  const actual = await hashFile("sha256", zipPath);
  if (actual !== expected) throw new Error(`gyan.dev sha256 mismatch — refusing to use this download.`);
  console.log("  [ok] sha256 verified against gyan.dev's published checksum");
  const extractDir = path.join(workDir, "extracted");
  await extractArchive(zipPath, extractDir);
  const bin = await findFile(extractDir, "ffmpeg.exe");
  if (!bin) throw new Error("gyan.dev zip did not contain a bin/ffmpeg.exe");
  return bin;
}

async function fetchFfmpegJohnVanSickle(workDir, arch) {
  console.log(`  source: johnvansickle.com (static Linux build, md5-checked)`);
  const archiveUrl = `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arch}-static.tar.xz`;
  const archivePath = path.join(workDir, `ffmpeg-${arch}.tar.xz`);
  await download(archiveUrl, archivePath);
  const md5Line = await fetchText(`${archiveUrl}.md5`);
  const expected = md5Line.trim().split(/\s+/)[0];
  const actual = await hashFile("md5", archivePath);
  if (actual !== expected) {
    throw new Error(`johnvansickle.com md5 mismatch for ${arch} — refusing to use this download.\n  expected: ${expected}\n  got:      ${actual}`);
  }
  console.log("  [ok] md5 verified against johnvansickle.com's published checksum");
  const extractDir = path.join(workDir, "extracted");
  await extractArchive(archivePath, extractDir);
  const bin = await findFile(extractDir, "ffmpeg");
  if (!bin) throw new Error(`johnvansickle.com ${arch} archive did not contain an 'ffmpeg' binary`);
  return bin;
}

async function fetchChromaprintAsset(workDir, assetPattern, binaryName) {
  const release = JSON.parse(await fetchText("https://api.github.com/repos/acoustid/chromaprint/releases/latest"));
  const asset = release.assets.find((a) => assetPattern.test(a.name));
  if (!asset) throw new Error(`no chromaprint release asset matching ${assetPattern} in ${release.tag_name}`);
  console.log(`  fetching fpcalc (${release.tag_name}) from ${asset.browser_download_url}`);
  const archivePath = path.join(workDir, asset.name);
  await download(asset.browser_download_url, archivePath);
  console.log(`  [info] no official checksum published for chromaprint releases — recorded sha256: ${await hashFile("sha256", archivePath)}`);
  const extractDir = path.join(workDir, "extracted");
  await extractArchive(archivePath, extractDir);
  const bin = await findFile(extractDir, binaryName);
  if (!bin) throw new Error(`${asset.name} did not contain a '${binaryName}' binary`);
  return bin;
}

async function place(sourcePath, target, binaryName) {
  const destDir = path.join(OUT_DIR, target);
  await mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, `${binaryName}${exeSuffix(target)}`);
  await pipeline(createReadStream(sourcePath), createWriteStream(destPath));
  await chmod(destPath, 0o755);
  return destPath;
}

const FFMPEG_FETCHERS = {
  "darwin-arm64": (workDir) =>
    fetchFfmpegOsxExperts(workDir, { url: OSXEXPERTS_FFMPEG_ARM64_URL, sha256: OSXEXPERTS_FFMPEG_ARM64_SHA256, strict: false }),
  "darwin-x64-baseline": (workDir) =>
    fetchFfmpegOsxExperts(workDir, { url: OSXEXPERTS_FFMPEG_X64_URL, sha256: OSXEXPERTS_FFMPEG_X64_SHA256, strict: true }),
  "windows-x64-baseline": fetchFfmpegGyan,
  "linux-x64-baseline": (workDir) => fetchFfmpegJohnVanSickle(workDir, "amd64"),
  "linux-arm64": (workDir) => fetchFfmpegJohnVanSickle(workDir, "arm64"),
};

const FPCALC_ASSET_PATTERNS = {
  "darwin-arm64": /-macos-universal\.tar\.gz$/,
  "darwin-x64-baseline": /-macos-universal\.tar\.gz$/,
  "windows-x64-baseline": /-windows-x86_64\.zip$/,
  "linux-x64-baseline": /-linux-x86_64\.tar\.gz$/,
  "linux-arm64": /-linux-arm64\.tar\.gz$/,
};

async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length > 0 ? requested : RELEASE_TARGETS;
  for (const t of targets) {
    if (!RELEASE_TARGETS.includes(t)) {
      throw new Error(`unknown target "${t}" — expected one of: ${RELEASE_TARGETS.join(", ")}`);
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const manifest = [];

  const withWorkDir = async (label, fn) => {
    console.log(`\n${label}`);
    const workDir = await mkdtemp(path.join(tmpdir(), "legato-release-media-binaries-"));
    try {
      return await fn(workDir);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  for (const target of targets) {
    await withWorkDir(`ffmpeg: ${target}`, async (workDir) => {
      const bin = await FFMPEG_FETCHERS[target](workDir);
      const destPath = await place(bin, target, "ffmpeg");
      manifest.push({ path: path.relative(OUT_DIR, destPath), sha256: await hashFile("sha256", destPath) });
      console.log(`  -> ${path.relative(REPO_ROOT, destPath)}`);
    });

    await withWorkDir(`fpcalc: ${target}`, async (workDir) => {
      const bin = await fetchChromaprintAsset(workDir, FPCALC_ASSET_PATTERNS[target], `fpcalc${exeSuffix(target)}`);
      const destPath = await place(bin, target, "fpcalc");
      manifest.push({ path: path.relative(OUT_DIR, destPath), sha256: await hashFile("sha256", destPath) });
      console.log(`  -> ${path.relative(REPO_ROOT, destPath)}`);
    });
  }

  const manifestPath = path.join(OUT_DIR, "MEDIA-BINARIES.sha256");
  await writeFile(manifestPath, manifest.map((m) => `${m.sha256}  ${m.path}`).join("\n") + "\n");
  console.log(`\nDone. Binaries under ${path.relative(REPO_ROOT, OUT_DIR)}/<target>/, manifest at ${path.relative(REPO_ROOT, manifestPath)}.`);
}

main().catch((err) => {
  console.error(`\nfetch-release-media-binaries failed: ${err.message}`);
  process.exit(1);
});
