#!/usr/bin/env node
// The desktop release's plumbing (#129), one target at a time, as
// .github/workflows/desktop.yml runs it on each runner:
//
//   stage --target <triple> --config-out <file> [--version <v>] [--pubkey <key>]
//     Copies this target's ffmpeg and fpcalc from server/dist/<compile
//     target>/, where scripts/fetch-release-media-binaries.mjs leaves them,
//     to src-tauri/binaries/<triple>/, which the bundle takes them from.
//     On macOS with APPLE_SIGNING_IDENTITY set, signs them and the server
//     sidecar (see signMac below). Then writes the tauri.conf.json patch the
//     build is run with (`tauri build --config <file>`).
//
//   collect --target <triple> --out <dir>
//     Copies what `tauri build --target <triple>` made into <dir> under the
//     names the release publishes, and notes which file the updater takes
//     for this platform in <dir>/<triple>.updater.json.
//
//   verify --target <triple> [--signed]
//     Checks what `tauri build` made: the bundle carries the server, ffmpeg
//     and fpcalc, each built for this target, and no second copy of the
//     server in its resources. With --signed (macOS), that the app passes
//     codesign --verify --deep --strict with the hardened runtime on
//     throughout, and that only the server has entitlements.
//
//   launch --target <triple>
//     Starts the packaged app on this machine (macOS, or Linux's AppImage
//     under xvfb-run) and checks that it starts its own server on 8899 and
//     hands it the bundle's own ffmpeg and fpcalc, then quits it and checks
//     the server went too. Only on a machine with nothing on 8899: a CI
//     runner, not a computer with Legato installed. --app (macOS) and
//     --port point it at a test build instead, and --exe (Linux) at an
//     installed app, such as the .deb's.
//
//   manifest --dir <dir> --version <v>
//     Writes <dir>/latest.json, the file the app's updater reads from the
//     latest release (src-tauri/src/updater.rs), from every target's note
//     and the signature Tauri wrote beside each update.
//
// The server sidecar itself comes first, from
// `node scripts/build-server-sidecar.mjs --target <triple>`.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const BINARIES_DIR = path.join(TAURI_DIR, "binaries");
const SIDECAR_ENTITLEMENTS = path.join(TAURI_DIR, "entitlements", "legato-server.plist");

// compile: server/scripts/compile.ts's target, which names the folder the
// media binaries were fetched into. platform: the updater's key for this
// target in latest.json ({os}-{arch}, tauri-plugin-updater's names).
const TARGETS = {
  "aarch64-apple-darwin": { os: "macos", compile: "darwin-arm64", platform: "darwin-aarch64" },
  "x86_64-apple-darwin": { os: "macos", compile: "darwin-x64-baseline", platform: "darwin-x86_64" },
  "x86_64-pc-windows-msvc": { os: "windows", compile: "windows-x64-baseline", platform: "windows-x86_64" },
  "x86_64-unknown-linux-gnu": { os: "linux", compile: "linux-x64-baseline", platform: "linux-x86_64" },
  "aarch64-unknown-linux-gnu": { os: "linux", compile: "linux-arm64", platform: "linux-aarch64" },
};

const MEDIA_BINARIES = ["ffmpeg", "fpcalc"];

// Signed code gets an identifier of the app's own rather than codesign's
// default, the file name, so its designated requirement reads the same in
// every build.
const BUNDLE_ID = "fm.legato.app";

function option(args, name, { required = false } = {}) {
  const i = args.indexOf(`--${name}`);
  const value = i === -1 ? undefined : args[i + 1];
  if (required && !value) throw new Error(`--${name} is required`);
  return value;
}

function targetOf(args) {
  const triple = option(args, "target", { required: true });
  const target = TARGETS[triple];
  if (!target) throw new Error(`no desktop release for ${triple}; the targets are ${Object.keys(TARGETS).join(", ")}`);
  return { triple, ...target, exe: target.os === "windows" ? ".exe" : "" };
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) throw new Error(`couldn't run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`);
}

// The flags Tauri's own signing uses for the app (tauri-macos-sign: --force,
// the identity, and --options runtime for the hardened runtime), plus an
// identifier, and the sidecar's entitlements. Tauri signs the app and its
// main binary afterwards, with the same identity and no entitlements.
//
// The sidecar is signed here rather than by Tauri because Tauri gives every
// binary it signs the same entitlements, and Bun's JIT ones belong to the
// sidecar alone. So in a macOS release the sidecar reaches Contents/MacOS
// through bundle.macOS.files, which Tauri copies without re-signing, rather
// than bundle.externalBin, which it re-signs (see stage below).
function signMac(file, identity, { identifier, entitlements }) {
  const args = ["--force", "--sign", identity, "--options", "runtime", "--identifier", identifier];
  if (entitlements) args.push("--entitlements", entitlements);
  run("codesign", [...args, file]);
  run("codesign", ["--verify", "--strict", "--verbose=2", file]);
  run("codesign", ["--display", "--requirements", "-", file]);
}

async function stage(args) {
  const target = targetOf(args);
  const configOut = option(args, "config-out", { required: true });
  const version = option(args, "version");
  const pubkey = option(args, "pubkey");

  const sidecar = stagedSidecar(target);
  if (!existsSync(sidecar)) {
    throw new Error(`no sidecar at ${path.relative(REPO_ROOT, sidecar)}; run node scripts/build-server-sidecar.mjs --target ${target.triple} first`);
  }

  const mediaDir = path.join(BINARIES_DIR, target.triple);
  await mkdir(mediaDir, { recursive: true });
  const media = [];
  for (const name of MEDIA_BINARIES) {
    const from = path.join(REPO_ROOT, "server", "dist", target.compile, `${name}${target.exe}`);
    if (!existsSync(from)) {
      throw new Error(`no ${name} at ${path.relative(REPO_ROOT, from)}; run node scripts/fetch-release-media-binaries.mjs ${target.compile} first`);
    }
    const to = path.join(mediaDir, `${name}${target.exe}`);
    await copyFile(from, to);
    // An artifact download loses the executable bit.
    await chmod(to, 0o755);
    media.push({ name, file: to });
    console.log(`${name}: ${path.relative(REPO_ROOT, to)}`);
  }
  await chmod(sidecar, 0o755);

  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (target.os === "macos" && identity) {
    console.log(`\nsigning the sidecar, ffmpeg and fpcalc as "${identity}"`);
    for (const { name, file } of media) signMac(file, identity, { identifier: `${BUNDLE_ID}.${name}` });
    signMac(sidecar, identity, { identifier: `${BUNDLE_ID}.legato-server`, entitlements: SIDECAR_ENTITLEMENTS });
  } else if (target.os === "macos") {
    console.log("\nAPPLE_SIGNING_IDENTITY isn't set: the sidecar, ffmpeg and fpcalc stay as they came");
  }

  // A JSON merge patch over tauri.conf.json (RFC 7396: an object merges,
  // anything else replaces, null deletes).
  const patch = {
    build: {
      // The sidecar compile already built dist/ (server/scripts/compile.ts
      // embeds it), and a second sidecar compile would replace the one
      // just signed.
      beforeBuildCommand: null,
    },
    bundle: {
      // Only this target's media binaries. The base config's "binaries/"
      // would also copy the sidecar into Resources, a second unsigned copy
      // the app never runs.
      resources: { [`binaries/${target.triple}/`]: `binaries/${target.triple}/` },
      createUpdaterArtifacts: true,
    },
  };
  if (version) patch.version = version;
  if (pubkey) {
    patch.plugins = { updater: { pubkey } };
  } else {
    // The committed key: every installed app checks updates against it, so
    // a build mustn't go out with anything else.
    const conf = JSON.parse(await readFile(path.join(TAURI_DIR, "tauri.conf.json"), "utf8"));
    if (!isUpdaterPublicKey(conf.plugins?.updater?.pubkey)) {
      throw new Error(
        "tauri.conf.json's plugins.updater.pubkey isn't an updater public key. Commit the .pub that `tauri signer generate` wrote beside the key in TAURI_SIGNING_PRIVATE_KEY.",
      );
    }
  }
  if (target.os === "linux") {
    // Into usr/libexec/<product>/ in the .deb and the AppImage alike, not
    // externalBin's usr/bin: linuxdeploy rewrites the rpath of every
    // dynamically linked ELF under the AppImage's usr/bin and usr/lib, and
    // that drops the segment a Bun-compiled binary keeps its program in.
    // server_process.rs looks there on Linux.
    const { productName } = JSON.parse(await readFile(path.join(TAURI_DIR, "tauri.conf.json"), "utf8"));
    const files = { [`/usr/libexec/${productName}/legato-server`]: path.relative(TAURI_DIR, sidecar) };
    patch.bundle.externalBin = [];
    patch.bundle.linux = { deb: { files }, appimage: { files } };
  }
  if (target.os === "macos") {
    patch.bundle.externalBin = [];
    patch.bundle.macOS = { files: { "MacOS/legato-server": path.relative(TAURI_DIR, sidecar) } };
  }
  await mkdir(path.dirname(path.resolve(configOut)), { recursive: true });
  await writeFile(configOut, `${JSON.stringify(patch, null, 2)}\n`);
  console.log(`\ntauri.conf.json patch for ${target.triple}: ${configOut}`);
}

// What `tauri signer generate` writes to its .pub: base64 of a minisign
// public key file.
function isUpdaterPublicKey(value) {
  if (typeof value !== "string") return false;
  const text = Buffer.from(value, "base64").toString("utf8");
  return /^untrusted comment: minisign public key/.test(text) && text.trim().split("\n").length === 2;
}

function output(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`couldn't run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}\n${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

// How each target's architecture reads in `lipo -archs`, `file` and a
// .deb's control file.
const MACHO_ARCH = { "aarch64-apple-darwin": "arm64", "x86_64-apple-darwin": "x86_64" };
const ELF_ARCH = { "x86_64-unknown-linux-gnu": "x86-64", "aarch64-unknown-linux-gnu": "aarch64" };
const DEB_ARCH = { "x86_64-unknown-linux-gnu": "amd64", "aarch64-unknown-linux-gnu": "arm64" };

async function verify(args) {
  const target = targetOf(args);
  const signed = args.includes("--signed");
  const bundleDir = path.join(TAURI_DIR, "target", target.triple, "release", "bundle");
  const failures = [];
  const expect = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
    if (!ok) failures.push(what);
  };

  if (target.os === "macos") {
    const app = (await filesIn(path.join(bundleDir, "macos"), ".app"))[0];
    if (!app) throw new Error(`no .app in ${path.relative(REPO_ROOT, bundleDir)}/macos`);
    const contents = path.join(app, "Contents");
    const mainBinary = output("plutil", ["-extract", "CFBundleExecutable", "raw", path.join(contents, "Info.plist")]).trim();
    const arch = MACHO_ARCH[target.triple];
    const code = {
      app: path.join(contents, "MacOS", mainBinary),
      "legato-server": path.join(contents, "MacOS", "legato-server"),
      ffmpeg: path.join(contents, "Resources", "binaries", target.triple, "ffmpeg"),
      fpcalc: path.join(contents, "Resources", "binaries", target.triple, "fpcalc"),
    };
    for (const [name, file] of Object.entries(code)) {
      const there = existsSync(file);
      expect(there, `${name} at ${path.relative(app, file)}`);
      if (!there) continue;
      const archs = output("lipo", ["-archs", file]).trim().split(/\s+/);
      expect(archs.includes(arch), `${name} runs on ${arch} (${archs.join(", ")})`);
    }
    if (existsSync(code["legato-server"])) {
      expect(
        sha256(code["legato-server"]) === sha256(stagedSidecar(target)),
        "the bundle's server is byte for byte the one staged (and signed) for it",
      );
    }
    const stray = (await readdir(path.join(contents, "Resources", "binaries"))).filter((name) => name.startsWith("legato-server"));
    expect(stray.length === 0, `no second server in Resources/binaries${stray.length ? ` (found ${stray.join(", ")})` : ""}`);

    if (signed) {
      let verified = true;
      try {
        output("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
      } catch (err) {
        verified = false;
        console.log(err.message);
      }
      expect(verified, "codesign --verify --deep --strict passes");
      for (const [name, file] of [["the app", app], ...Object.entries(code)]) {
        const details = output("codesign", ["--display", "--verbose=2", file]);
        expect(/flags=0x[0-9a-f]+\([^)]*runtime/.test(details), `${name} has the hardened runtime`);
        console.log(`      ${output("codesign", ["--display", "--requirements", "-", file]).split("\n").find((line) => line.startsWith("designated")) ?? "no designated requirement"}`);
      }
      const entitlements = (file) => output("codesign", ["--display", "--entitlements", "-", "--xml", file]);
      expect(!entitlements(app).includes("<key>"), "the app has no entitlements");
      expect(entitlements(code["legato-server"]).includes("com.apple.security.cs.allow-jit"), "the server has Bun's JIT entitlements");
    }
  } else if (target.os === "linux") {
    const deb = await only(path.join(bundleDir, "deb"), ".deb");
    const listing = output("dpkg-deb", ["--contents", deb]);
    console.log(listing.split("\n").filter((line) => /usr\/(bin|lib|libexec)\//.test(line) && !line.endsWith("/")).join("\n"));
    expect(/\s(\.\/)?usr\/libexec\/[^/]+\/legato-server$/m.test(listing), ".deb has usr/libexec/<product>/legato-server");
    expect(!/\s(\.\/)?usr\/bin\/legato-server$/m.test(listing), ".deb puts no legato-server on PATH");
    for (const name of MEDIA_BINARIES) {
      expect(new RegExp(`/binaries/${target.triple}/${name}$`, "m").test(listing), `.deb has ${name} for ${target.triple}`);
    }
    const debArch = output("dpkg-deb", ["--field", deb, "Architecture"]).trim();
    expect(debArch === DEB_ARCH[target.triple], `.deb is for ${DEB_ARCH[target.triple]} (${debArch})`);
    expect(!/\/binaries\/legato-server/m.test(listing), ".deb has no second server in its resources");

    const appImage = await only(path.join(bundleDir, "appimage"), ".AppImage");
    const scratch = await mkdtemp(path.join(tmpdir(), "legato-appimage-"));
    try {
      await chmod(appImage, 0o755);
      output(appImage, ["--appimage-extract"], { cwd: scratch });
      const root = path.join(scratch, "squashfs-root");
      const files = output("find", [root, "-type", "f"]).split("\n");
      const find = (pattern) => files.find((file) => pattern.test(file));
      const code = {
        "legato-server": find(/\/usr\/libexec\/[^/]+\/legato-server$/),
        ffmpeg: find(new RegExp(`/usr/lib/[^/]+/binaries/${target.triple}/ffmpeg$`)),
        fpcalc: find(new RegExp(`/usr/lib/[^/]+/binaries/${target.triple}/fpcalc$`)),
      };
      for (const [name, file] of Object.entries(code)) {
        expect(Boolean(file), `AppImage has ${name}${file ? ` at ${path.relative(root, file)}` : ""}`);
        if (file) expect(output("file", ["-b", file]).includes(ELF_ARCH[target.triple]), `${name} in the AppImage runs on ${ELF_ARCH[target.triple]}`);
      }
      expect(!files.some((file) => /\/binaries\/legato-server/.test(file)), "AppImage has no second server in its resources");
      if (code["legato-server"]) {
        // linuxdeploy didn't get to it: an rpath rewrite would change it.
        expect(sha256(code["legato-server"]) === sha256(stagedSidecar(target)), "the AppImage's server is byte for byte the one built for it");
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } else {
    const installer = await only(path.join(bundleDir, "nsis"), "-setup.exe");
    const listing = output("7z", ["l", installer]);
    expect(/legato-server\.exe/.test(listing), "installer has legato-server.exe");
    for (const name of MEDIA_BINARIES) {
      expect(new RegExp(`binaries[\\\\/]${target.triple}[\\\\/]${name}\\.exe`).test(listing), `installer has ${name}.exe for ${target.triple}`);
    }
  }

  if (failures.length) throw new Error(`${failures.length} check${failures.length === 1 ? "" : "s"} failed: ${failures.join("; ")}`);
}

// A packaged build's server always takes this port (src-tauri/src/instance.rs).
const PACKAGED_PORT = 8899;

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// The LEGATO_* variables a running process was started with.
function legatoEnv(pid, os) {
  if (os === "linux") {
    return Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .filter((kv) => kv.startsWith("LEGATO_"))
        .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
    );
  }
  // macOS's ps prints the environment after the command line, space-separated.
  const line = output("ps", ["eww", "-o", "command=", "-p", String(pid)]);
  return Object.fromEntries([...line.matchAll(/(LEGATO_[A-Z_]+)=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|\n|$)/g)].map((m) => [m[1], m[2]]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch(args) {
  const target = targetOf(args);
  if (target.os === "windows") throw new Error("launch covers the macOS and Linux bundles");
  const port = Number(option(args, "port") ?? PACKAGED_PORT);
  if (await health(port)) throw new Error(`something already answers on ${port}`);
  const bundleDir = path.join(TAURI_DIR, "target", target.triple, "release", "bundle");
  const failures = [];
  const expect = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
    if (!ok) failures.push(what);
  };

  let command;
  let commandArgs = [];
  const env = { ...process.env };
  if (target.os === "macos") {
    const app = option(args, "app") ?? (await filesIn(path.join(bundleDir, "macos"), ".app"))[0];
    const mainBinary = output("plutil", ["-extract", "CFBundleExecutable", "raw", path.join(app, "Contents", "Info.plist")]).trim();
    command = path.join(app, "Contents", "MacOS", mainBinary);
  } else {
    // --exe: an installed app, such as the .deb's. Otherwise the AppImage,
    // which needs no FUSE this way.
    const installed = option(args, "exe");
    const exe = installed ?? (await only(path.join(bundleDir, "appimage"), ".AppImage"));
    if (!installed) {
      await chmod(exe, 0o755);
      env.APPIMAGE_EXTRACT_AND_RUN = "1";
    }
    // No display on a runner: xvfb-run gives the webview one.
    command = "xvfb-run";
    commandArgs = ["--auto-servernum", exe];
  }

  console.log(`starting ${path.relative(REPO_ROOT, command) || command} ${commandArgs.map((a) => path.relative(REPO_ROOT, a)).join(" ")}`);
  const app = spawn(command, commandArgs, { env, stdio: ["ignore", "inherit", "inherit"], detached: true });
  let exited = null;
  app.on("exit", (code, signal) => {
    exited = signal ?? code;
  });
  try {
    let body = null;
    for (const deadline = Date.now() + 120_000; Date.now() < deadline && exited === null; await sleep(1000)) {
      if ((body = await health(port))) break;
    }
    expect(Boolean(body), `the app's own server answered on ${port}${exited !== null ? ` (the app exited: ${exited})` : ""}`);
    if (body) {
      expect(body.installChannel === "desktop", `it runs as the desktop app's server (install channel ${body.installChannel})`);
      // The process listening on the port, not one found by name: a computer
      // can be running another Legato.
      const pid = output("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).trim().split("\n")[0];
      const serverEnv = legatoEnv(pid, target.os);
      for (const [name, variable] of [
        ["ffmpeg", "LEGATO_FFMPEG_PATH"],
        ["fpcalc", "LEGATO_FPCALC_PATH"],
      ]) {
        const given = serverEnv[variable] ?? "";
        expect(given.endsWith(`/binaries/${target.triple}/${name}`) && existsSync(given), `it was given the bundle's own ${name}: ${given || "nothing"}`);
      }
    }
  } finally {
    // SIGTERM is what the app's own signal handler tears the server down on
    // (server_process.rs), so the server should go with it.
    if (exited === null) process.kill(-app.pid, "SIGTERM");
    let stopped = false;
    for (let i = 0; i < 20 && !(stopped = !(await health(port))); i++) await sleep(500);
    expect(stopped, "the server stopped when the app did");
  }
  if (failures.length) throw new Error(`${failures.length} check${failures.length === 1 ? "" : "s"} failed: ${failures.join("; ")}`);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function stagedSidecar(target) {
  return path.join(BINARIES_DIR, `legato-server-${target.triple}${target.exe}`);
}

async function filesIn(dir, suffix) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((name) => name.endsWith(suffix)).map((name) => path.join(dir, name));
}

async function only(dir, suffix) {
  const found = await filesIn(dir, suffix);
  if (found.length !== 1) {
    throw new Error(`expected one *${suffix} in ${path.relative(REPO_ROOT, dir)}, found ${found.length ? found.map((f) => path.basename(f)).join(", ") : "none"}`);
  }
  return found[0];
}

async function collect(args) {
  const target = targetOf(args);
  const out = option(args, "out", { required: true });
  const bundleDir = path.join(TAURI_DIR, "target", target.triple, "release", "bundle");
  await mkdir(out, { recursive: true });

  const copies = []; // [from, release name]
  let update;
  if (target.os === "macos") {
    copies.push([await only(path.join(bundleDir, "dmg"), ".dmg")]);
    // Tauri names the macOS update after the app alone, the same for both
    // architectures, so it gets the version and architecture the DMG has.
    const dmgName = path.basename(copies[0][0], ".dmg");
    update = [await only(path.join(bundleDir, "macos"), ".app.tar.gz"), `${dmgName}.app.tar.gz`];
  } else if (target.os === "windows") {
    update = [await only(path.join(bundleDir, "nsis"), "-setup.exe")];
  } else {
    copies.push([await only(path.join(bundleDir, "deb"), ".deb")]);
    update = [await only(path.join(bundleDir, "appimage"), ".AppImage")];
  }
  const updateName = update[1] ?? path.basename(update[0]);
  copies.push(update, [`${update[0]}.sig`, `${updateName}.sig`]);

  for (const [from, name = path.basename(from)] of copies) {
    if (!existsSync(from)) throw new Error(`${path.relative(REPO_ROOT, from)} is missing; was the build run with the patch from stage?`);
    await copyFile(from, path.join(out, name));
    console.log(`${name}  <-  ${path.relative(REPO_ROOT, from)}`);
  }
  const note = { target: target.triple, platform: target.platform, file: updateName };
  await writeFile(path.join(out, `${target.triple}.updater.json`), `${JSON.stringify(note, null, 2)}\n`);
}

async function manifest(args) {
  const dir = option(args, "dir", { required: true });
  const version = option(args, "version", { required: true });
  const repo = process.env.GITHUB_REPOSITORY || "danielbchurchill/legato";
  const tag = `v${version}`;

  const platforms = {};
  for (const noteFile of await filesIn(dir, ".updater.json")) {
    const note = JSON.parse(await readFile(noteFile, "utf8"));
    if (platforms[note.platform]) throw new Error(`two updates for ${note.platform}`);
    const signature = (await readFile(path.join(dir, `${note.file}.sig`), "utf8")).trim();
    platforms[note.platform] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(note.file)}`,
    };
  }
  const missing = Object.values(TARGETS).map((t) => t.platform).filter((p) => !platforms[p]);
  if (missing.length) throw new Error(`no update for ${missing.join(", ")}; every target has to build before the release gets a latest.json`);

  const latest = {
    version,
    notes: `https://github.com/${repo}/releases/tag/${tag}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
  await writeFile(path.join(dir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`latest.json for ${tag}: ${Object.keys(platforms).sort().join(", ")}`);
}

const [command, ...args] = process.argv.slice(2);
const commands = { stage, collect, verify, launch, manifest };
if (!commands[command]) {
  console.error("usage: node scripts/desktop-release.mjs stage|collect|verify|launch|manifest [options] (see the header comment)");
  process.exit(1);
}
commands[command](args).catch((err) => {
  console.error(`\ndesktop-release ${command} failed: ${err.message}`);
  process.exit(1);
});
