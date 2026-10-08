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
//
// Every binary also embeds the web client (issue #116), served at / by
// src/routes/web-client.ts. By default this script runs the repo root's
// `npm run build` first, so the embedded copy is always built from the same
// checkout as the server around it, never a dist/ left over from some
// earlier branch. LEGATO_WEB_DIST=<dir> skips that and embeds an
// already-built client instead: server/Dockerfile builds it in its own
// stage, where the server stage has no root node_modules to build with.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateMigrationsManifest } from "./generate-migrations-manifest.mjs";

const SERVER_DIR = path.join(import.meta.dirname, "..");
const REPO_ROOT = path.join(SERVER_DIR, "..");
const DIST_DIR = path.join(SERVER_DIR, "dist");
// Generated per compile, under the already-gitignored dist/.
const WEB_EMBED_DIR = path.join(DIST_DIR, ".web-embed");

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

function prepareWebClient(): string {
  const prebuilt = process.env.LEGATO_WEB_DIST;
  let webDir: string;
  if (prebuilt) {
    webDir = path.resolve(prebuilt);
    console.log(`web client: embedding prebuilt ${webDir} (LEGATO_WEB_DIST)`);
  } else {
    console.log("web client: building (npm run build in the repo root)...");
    const result = spawnSync("npm", ["run", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      throw new Error(
        `web client build failed (exit ${result.status}) — the binary serves it at /, so it can't be skipped. Is the root \`npm install\` done?`,
      );
    }
    webDir = path.join(REPO_ROOT, "dist");
  }
  // A binary with no client would boot clean and answer / with a bare 404,
  // which looks like a routing bug rather than a packaging one.
  if (!existsSync(path.join(webDir, "index.html"))) {
    throw new Error(`no index.html in ${webDir} — that isn't a built web client`);
  }
  return webDir;
}

// `bun build --compile` only embeds what a static import pulls in, so this
// writes one `import … with { type: "file" }` per client file into a module
// that hands them to src/routes/web-client.ts, plus an entrypoint that
// imports that module *before* src/index.ts. ES modules evaluate their
// imports in order, so the map is full before index.ts registers the
// plugin that reads it. Returns the entrypoints to compile.
//
// The second entrypoint is recompute's Worker (issue #281), which a static
// import never reaches: src/recompute.ts starts it with
// `new Worker(new URL("./recomputeWorker.ts", import.meta.url))`. Inside the
// binary, import.meta.url is the binary itself at the root of Bun's
// embedded file system, and every entrypoint sits at its path below the
// entrypoints' shared folder. So the worker gets a one-line wrapper of the
// same name beside entry.generated.ts, which puts it where that URL points.
function writeWebEmbed(webDir: string): { entrypoints: string[]; count: number } {
  rmSync(WEB_EMBED_DIR, { recursive: true, force: true });
  mkdirSync(WEB_EMBED_DIR, { recursive: true });

  // Relative, forward-slash specifiers: an absolute Windows path isn't a
  // valid import specifier.
  const specifier = (target: string) => {
    const relative = path.relative(WEB_EMBED_DIR, target).split(path.sep).join("/");
    return JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`);
  };

  const files = (readdirSync(webDir, { recursive: true }) as string[])
    .filter((relative) => !path.basename(relative).startsWith("."))
    .filter((relative) => statSync(path.join(webDir, relative)).isFile())
    .sort();

  const imports = files.map((relative, i) => `import w${i} from ${specifier(path.join(webDir, relative))} with { type: "file" };`);
  const entries = files.map((relative, i) => `  ${JSON.stringify(`/${relative.split(path.sep).join("/")}`)}: w${i},`);

  const assetsModule = path.join(WEB_EMBED_DIR, "assets.generated.ts");
  writeFileSync(
    assetsModule,
    `// GENERATED by server/scripts/compile.ts for one compile — not committed.
import { registerEmbeddedWebClient } from ${specifier(path.join(SERVER_DIR, "src", "routes", "web-client.ts"))};
${imports.join("\n")}

registerEmbeddedWebClient({
${entries.join("\n")}
});
`,
  );

  const entry = path.join(WEB_EMBED_DIR, "entry.generated.ts");
  writeFileSync(
    entry,
    `// GENERATED by server/scripts/compile.ts for one compile — not committed.
import "./assets.generated.ts";
import ${specifier(path.join(SERVER_DIR, "src", "index.ts"))};
`,
  );

  const worker = path.join(WEB_EMBED_DIR, "recomputeWorker.ts");
  writeFileSync(
    worker,
    `// GENERATED by server/scripts/compile.ts for one compile — not committed.
import ${specifier(path.join(SERVER_DIR, "src", "recomputeWorker.ts"))};
`,
  );

  return { entrypoints: [entry, worker], count: files.length };
}

async function compileTarget(name: string, entrypoints: string[], version: string, gitSha: string): Promise<{ name: string; outFile: string; bytes: number }> {
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
    entrypoints,
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

  const { entrypoints, count: webFileCount } = writeWebEmbed(prepareWebClient());
  console.log(`web client: ${webFileCount} files embedded\n`);

  const version = resolveVersion();
  const gitSha = resolveGitSha();
  console.log(`version: ${version} (${gitSha})\n`);

  const results: { name: string; outFile: string; bytes: number }[] = [];
  for (const name of targets) {
    console.log(`compiling ${name}...`);
    const result = await compileTarget(name, entrypoints, version, gitSha);
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
