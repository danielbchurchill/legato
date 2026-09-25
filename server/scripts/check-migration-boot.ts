#!/usr/bin/env bun
// Issue #102's actual named risk: "the most likely thing to break
// silently" per docs/plans/01-server-distribution.md's Compile section.
// A compiled binary has no source tree, so if migrations weren't really
// embedded (a stale manifest, a bundler regression, an empty target dir
// that shadowed the real one), it boots clean, serves traffic, and just
// quietly has no schema — nothing about that fails loudly on its own.
//
// This boots a real compiled binary against a brand-new, empty
// LEGATO_DATA_DIR, waits for it to come up, and checks the migration
// count actually applied to the resulting database against the manifest
// this same binary was built with. Used two ways: as a CI job (see
// .github/workflows/release.yml) after every real compile, and as the
// manual "run it by hand once" step issue #102 asked for before trusting
// any of this.
//
// Usage: bun scripts/check-migration-boot.ts <path-to-compiled-binary>
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MIGRATIONS } from "../src/migrations/manifest.generated.js";
import { openSqlite } from "../src/sqlite.js";

const binaryPath = process.argv[2];
if (!binaryPath) {
  console.error("usage: bun scripts/check-migration-boot.ts <path-to-compiled-binary>");
  process.exit(1);
}

const BOOT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;

async function waitForHealth(port: number, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`server never answered /api/v1/health within ${BOOT_TIMEOUT_MS}ms`);
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "legato-migration-boot-check-"));
  // Fixed dev ports (8899, 5173, ...) are already claimed by real dev
  // instances on this machine and elsewhere — a random high port avoids
  // colliding with either those or a concurrent run of this same check.
  const port = 20000 + Math.floor(Math.random() * 20000);

  console.log(`binary:    ${binaryPath}`);
  console.log(`data dir:  ${dataDir} (empty)`);
  console.log(`port:      ${port}`);

  const proc = Bun.spawn([binaryPath], {
    env: { ...process.env, LEGATO_DATA_DIR: dataDir, LEGATO_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  let stderrOutput = "";
  void (async () => {
    for await (const chunk of proc.stderr) stderrOutput += new TextDecoder().decode(chunk);
  })();

  try {
    await waitForHealth(port, Date.now() + BOOT_TIMEOUT_MS);
    console.log("server booted and answered /api/v1/health");

    const dbPath = path.join(dataDir, "legato.db");
    const db = openSqlite(dbPath);
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    db.close();

    const expected = MIGRATIONS.length;
    console.log(`applied migrations: ${count} (expected ${expected}, from manifest.generated.ts)`);

    if (count !== expected) {
      throw new Error(
        `migration boot check FAILED: expected ${expected} applied migrations against a fresh data dir, got ${count}. ` +
          `This is exactly the silent-failure mode this check exists to catch — see this script's header comment.`,
      );
    }

    console.log("migration boot check PASSED");
  } finally {
    proc.kill();
    await proc.exited;
    if (stderrOutput.trim()) {
      console.log("\n--- server stderr ---");
      console.log(stderrOutput.trim());
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
