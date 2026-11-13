// Test-only: bun test runs this before each spec file's own imports, through
// server/bunfig.toml's [test] preload. Under --isolate, which
// `npm --prefix server test` passes, it runs again for every file, each in a
// fresh global with a fresh process.env.
//
// Issue #506: config.ts fixes DATA_DIR when it's first imported, and without
// LEGATO_DATA_DIR it falls back to ~/.local/share/legato, the directory a
// standalone `npm --prefix server run dev` uses. The waveform, cover, stream
// and picture caches all live under DATA_DIR, so specs that decoded a real
// file left peaks in a contributor's real cache. Each spec file gets a fresh
// temporary data dir instead, set here whatever the shell had, and removed
// once the file's last afterAll has run.
//
// It reaches only this process's process.env. A Worker or a Bun.spawn child
// started without an env of its own gets the environment bun test started
// with, so a spec that starts a server or a worker that writes to DATA_DIR
// passes LEGATO_DATA_DIR itself. check.yml runs the suite with an empty HOME
// and fails if anything lands in it.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "legato-test-data-"));
process.env.LEGATO_DATA_DIR = dataDir;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
