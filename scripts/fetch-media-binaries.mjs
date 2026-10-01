#!/usr/bin/env node
// Downloads real ffmpeg + fpcalc (Chromaprint) binaries for the platforms
// Legato needs to bundle a packaged app for — macOS arm64/x64 and Windows
// x64 — into src-tauri/binaries/<rust-target-triple>/, gitignored (never
// commit these blobs). src-tauri/tauri.conf.json's bundle.resources picks
// up that whole directory, and src-tauri/src/server_process.rs resolves a
// path inside it at runtime and hands it to the Node server as
// LEGATO_FFMPEG_PATH/LEGATO_FPCALC_PATH (see server/src/mediaBinaries.ts).
// Linux keeps relying on system ffmpeg, so nothing here
// touches it.
//
// Run: node scripts/fetch-media-binaries.mjs   (or `npm run fetch:media-binaries`)
// Requires: unzip, tar on PATH (present by default on macOS/Linux). gpg is
// optional — used for the one source below that publishes a real signature;
// its absence downgrades that source to a warning, not a hard failure.
//
// ---------------------------------------------------------------------------
// Where each binary comes from, and how this script verifies it:
//
// ffmpeg / macOS x86_64 — evermeet.cx (https://evermeet.cx/ffmpeg/), the
//   build ffmpeg.org's own official download page (ffmpeg.org/download.html)
//   links to for macOS. Fetched via its documented info API
//   (GET /ffmpeg/info/ffmpeg/release) so this always gets the exact current
//   release URL rather than a version pinned in this script. Verified with a
//   real GPG signature check against the maintainer's published key
//   fingerprint (20F6 EA3E 0CFD 6B4C 5344 7A73 476C 4B61 1A66 0874, listed on
//   evermeet.cx/ffmpeg/) — a bad or unverifiable signature aborts the whole
//   script; a missing `gpg` binary or unreachable keyserver only warns, since
//   evermeet.cx is still served over plain HTTPS either way.
//
// ffmpeg / macOS arm64 — evermeet.cx explicitly does not build for Apple
//   Silicon (confirmed on evermeet.cx/ffmpeg/ as of 2026-08-31), and no
//   arm64 build is linked from ffmpeg.org's official download page either —
//   there is no "official" source for this one. osxexperts.net
//   (https://www.osxexperts.net/) is the de facto community standard
//   fallback (referenced by numerous ffmpeg-on-Apple-Silicon build guides)
//   and is the only source found that both targets arm64 natively and
//   publishes a per-binary sha256. That published hash is for the
//   *extracted* ffmpeg binary, not the zip wrapper — confirmed by hand
//   against a real download on 2026-08-31, see OSXEXPERTS_FFMPEG_ARM64_SHA256
//   below. Its download URL has no version in it (osxexperts.net/ffmpeg9arm.zip
//   today), so a hash mismatch here is a soft warning, not a hard failure —
//   it likely just means the site shipped a newer build than this script's
//   pinned reference. This is the weakest-trust link in this script; there
//   is currently no better option for native arm64 static ffmpeg.
//
// ffmpeg / Windows x64 — gyan.dev (https://www.gyan.dev/ffmpeg/builds/), the
//   other build ffmpeg.org's download page links to for Windows (alongside
//   BtbN/FFmpeg-Builds, which doesn't publish macOS builds and so isn't used
//   here for consistency with the mac sources). The "release-essentials"
//   variant. Verified against the real sha256 published alongside it
//   (<url>.sha256), fetched fresh each run — a strict, hard-fail check
//   independent of version churn.
//
// fpcalc (Chromaprint), all three platforms — the project's own GitHub
//   releases (https://github.com/acoustid/chromaprint/releases), the most
//   official source that exists for it. Uses the "macos-universal" asset
//   (one binary for both Intel and Apple Silicon Macs) plus
//   "windows-x86_64". GitHub releases don't publish separate checksums for
//   these assets, so there is nothing to verify *against* — this script
//   instead computes and records the sha256 of what it downloaded (in
//   CHECKSUMS.sha256 alongside the binaries) so a future run's diff is at
//   least visible, on top of the baseline of HTTPS + the binary coming
//   straight from the upstream project's own GitHub org.
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
const OUT_DIR = path.join(REPO_ROOT, "src-tauri", "binaries");

const EVERMEET_KEY_FINGERPRINT = "20F6EA3E0CFD6B4C53447A73476C4B611A660874";

// Captured 2026-08-31 from the sha256 osxexperts.net publishes next to its
// ffmpeg9arm.zip download, verified by hand against the *extracted* binary.
// Expected to go stale whenever that site ships a new build — see the
// header comment above for why that's a warning here, not a failure.
const OSXEXPERTS_FFMPEG_ARM64_URL = "https://www.osxexperts.net/ffmpeg9arm.zip";
const OSXEXPERTS_FFMPEG_ARM64_SHA256 = "591260c945d0eef150e3bf82b0ef988bd36a9cecc18ff05d6679617159f0a95e";

const EXE = { "x86_64-pc-windows-msvc": ".exe" };
const exeSuffix = (triple) => EXE[triple] ?? "";

function haveCommand(cmd) {
  const result = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return !result.error;
}

async function download(url, destPath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  await mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
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
  } else {
    throw new Error(`don't know how to extract ${archivePath}`);
  }
}

// Recursively finds a file by exact basename. Every archive here nests its
// binary under a version- or platform-named folder that changes release to
// release (confirmed by hand for all four sources on 2026-08-31), so
// searching by name is what keeps this script from going stale the next
// time any of them bump a version number. __MACOSX is AppleDouble junk zip
// adds when it's built on a Mac (seen in the osxexperts.net archive).
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

async function verifyEvermeetSignature(zipPath, sigPath, workDir) {
  if (!haveCommand("gpg")) {
    console.warn(
      "  [warn] gpg not found on PATH — skipping signature verification for the evermeet.cx " +
        "build. To verify by hand: gpg --verify <file>.sig <file>, expect key fingerprint " +
        "20F6 EA3E 0CFD 6B4C 5344 7A73 476C 4B61 1A66 0874.",
    );
    return;
  }

  const gnupgHome = path.join(workDir, "gnupg");
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 });

  const recv = spawnSync(
    "gpg",
    ["--batch", "--homedir", gnupgHome, "--keyserver", "hkps://keys.openpgp.org", "--recv-keys", EVERMEET_KEY_FINGERPRINT],
    { encoding: "utf8" },
  );
  if (recv.status !== 0) {
    console.warn(
      `  [warn] could not fetch evermeet.cx's signing key from keys.openpgp.org — skipping ` +
        `signature verification. ${(recv.stderr ?? "").trim()}`,
    );
    return;
  }

  const verify = spawnSync("gpg", ["--batch", "--status-fd", "1", "--homedir", gnupgHome, "--verify", sigPath, zipPath], {
    encoding: "utf8",
  });
  const output = `${verify.stdout ?? ""}${verify.stderr ?? ""}`;
  const good = verify.status === 0 && output.includes("GOODSIG") && output.includes(EVERMEET_KEY_FINGERPRINT);
  if (!good) {
    throw new Error(`evermeet.cx GPG signature verification FAILED — refusing to use this download.\n${output}`);
  }
  console.log("  [ok] evermeet.cx GPG signature verified against pinned key fingerprint");
}

async function fetchFfmpegEvermeet(workDir) {
  console.log("  source: evermeet.cx (official, GPG-signed)");
  const info = JSON.parse(await fetchText("https://evermeet.cx/ffmpeg/info/ffmpeg/release"));
  const zipUrl = info.download.zip.url;
  const sigUrl = info.download.zip.sig;
  console.log(`  fetching ffmpeg ${info.version} from ${zipUrl}`);

  const zipPath = path.join(workDir, "ffmpeg-evermeet.zip");
  const sigPath = `${zipPath}.sig`;
  await download(zipUrl, zipPath);
  await download(sigUrl, sigPath);
  await verifyEvermeetSignature(zipPath, sigPath, workDir);

  const extractDir = path.join(workDir, "extracted");
  await extractArchive(zipPath, extractDir);
  const bin = await findFile(extractDir, "ffmpeg");
  if (!bin) throw new Error("evermeet.cx zip did not contain an 'ffmpeg' binary");
  return bin;
}

async function fetchFfmpegOsxExperts(workDir) {
  console.log("  source: osxexperts.net (community, sha256-checked)");
  console.log(`  fetching ${OSXEXPERTS_FFMPEG_ARM64_URL}`);

  const zipPath = path.join(workDir, "ffmpeg-osxexperts.zip");
  await download(OSXEXPERTS_FFMPEG_ARM64_URL, zipPath);

  const extractDir = path.join(workDir, "extracted");
  await extractArchive(zipPath, extractDir);
  const bin = await findFile(extractDir, "ffmpeg");
  if (!bin) throw new Error("osxexperts.net zip did not contain an 'ffmpeg' binary");

  const actual = await sha256File(bin);
  if (actual === OSXEXPERTS_FFMPEG_ARM64_SHA256) {
    console.log("  [ok] sha256 matches the reference captured 2026-08-31");
  } else {
    console.warn(
      `  [warn] sha256 mismatch against the reference captured 2026-08-31 — osxexperts.net's ` +
        `unversioned URL has likely shipped a newer build since then. This is expected drift, ` +
        `not necessarily a problem, but worth a manual look at https://www.osxexperts.net/ if ` +
        `it surprises you.\n    expected: ${OSXEXPERTS_FFMPEG_ARM64_SHA256}\n    got:      ${actual}`,
    );
  }
  return bin;
}

async function fetchFfmpegGyan(workDir) {
  console.log("  source: gyan.dev (official Windows build, sha256-checked)");
  const zipUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
  console.log(`  fetching ${zipUrl}`);

  const zipPath = path.join(workDir, "ffmpeg-gyan.zip");
  await download(zipUrl, zipPath);
  const expected = (await fetchText(`${zipUrl}.sha256`)).trim().split(/\s+/)[0];
  const actual = await sha256File(zipPath);
  if (actual !== expected) {
    throw new Error(`gyan.dev sha256 mismatch — refusing to use this download.\n  expected: ${expected}\n  got:      ${actual}`);
  }
  console.log("  [ok] sha256 verified against gyan.dev's published checksum");

  const extractDir = path.join(workDir, "extracted");
  await extractArchive(zipPath, extractDir);
  const bin = await findFile(extractDir, "ffmpeg.exe");
  if (!bin) throw new Error("gyan.dev zip did not contain a bin/ffmpeg.exe");
  return bin;
}

async function fetchChromaprintAsset(workDir, assetPattern, binaryName) {
  const release = JSON.parse(await fetchText("https://api.github.com/repos/acoustid/chromaprint/releases/latest"));
  const asset = release.assets.find((a) => assetPattern.test(a.name));
  if (!asset) throw new Error(`no chromaprint release asset matching ${assetPattern} in ${release.tag_name}`);
  console.log(`  fetching fpcalc (${release.tag_name}) from ${asset.browser_download_url}`);

  const archivePath = path.join(workDir, asset.name);
  await download(asset.browser_download_url, archivePath);

  const hash = await sha256File(archivePath);
  console.log(`  [info] no official checksum published for chromaprint releases — recorded sha256: ${hash}`);

  const extractDir = path.join(workDir, "extracted");
  await extractArchive(archivePath, extractDir);
  const bin = await findFile(extractDir, binaryName);
  if (!bin) throw new Error(`${asset.name} did not contain a '${binaryName}' binary`);
  return bin;
}

async function place(sourcePath, triple, binaryName) {
  const destDir = path.join(OUT_DIR, triple);
  await mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, `${binaryName}${exeSuffix(triple)}`);
  await pipeline(createReadStream(sourcePath), createWriteStream(destPath));
  await chmod(destPath, 0o755);
  return destPath;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const manifest = [];

  const withWorkDir = async (label, fn) => {
    console.log(`\n${label}`);
    const workDir = await mkdtemp(path.join(tmpdir(), "legato-media-binaries-"));
    try {
      return await fn(workDir);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  };

  const ffmpegTargets = [
    { triple: "x86_64-apple-darwin", label: "ffmpeg: macOS x86_64", fetch: fetchFfmpegEvermeet },
    { triple: "aarch64-apple-darwin", label: "ffmpeg: macOS arm64", fetch: fetchFfmpegOsxExperts },
    { triple: "x86_64-pc-windows-msvc", label: "ffmpeg: Windows x64", fetch: fetchFfmpegGyan },
  ];

  // place() must run while workDir (holding the extracted binary findFile
  // located) is still alive, so every fetch+place pair happens inside one
  // withWorkDir call rather than after it returns.
  for (const target of ffmpegTargets) {
    await withWorkDir(target.label, async (workDir) => {
      const bin = await target.fetch(workDir);
      const destPath = await place(bin, target.triple, "ffmpeg");
      manifest.push({ path: path.relative(OUT_DIR, destPath), sha256: await sha256File(destPath) });
      console.log(`  -> ${path.relative(REPO_ROOT, destPath)}`);
    });
  }

  await withWorkDir("fpcalc: macOS (universal, arm64 + x86_64)", async (workDir) => {
    const bin = await fetchChromaprintAsset(workDir, /-macos-universal\.tar\.gz$/, "fpcalc");
    for (const triple of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
      const destPath = await place(bin, triple, "fpcalc");
      manifest.push({ path: path.relative(OUT_DIR, destPath), sha256: await sha256File(destPath) });
      console.log(`  -> ${path.relative(REPO_ROOT, destPath)}`);
    }
  });

  await withWorkDir("fpcalc: Windows x64", async (workDir) => {
    const bin = await fetchChromaprintAsset(workDir, /-windows-x86_64\.zip$/, "fpcalc.exe");
    const destPath = await place(bin, "x86_64-pc-windows-msvc", "fpcalc");
    manifest.push({ path: path.relative(OUT_DIR, destPath), sha256: await sha256File(destPath) });
    console.log(`  -> ${path.relative(REPO_ROOT, destPath)}`);
  });

  const manifestPath = path.join(OUT_DIR, "CHECKSUMS.sha256");
  await writeFile(manifestPath, manifest.map((m) => `${m.sha256}  ${m.path}`).join("\n") + "\n");

  console.log(`\nDone. Binaries in ${path.relative(REPO_ROOT, OUT_DIR)}/, manifest at ${path.relative(REPO_ROOT, manifestPath)}.`);
  console.log("None of this is committed (see .gitignore) — re-run this script wherever the app is actually packaged.");
}

main().catch((err) => {
  console.error(`\nfetch-media-binaries failed: ${err.message}`);
  process.exit(1);
});
