#!/usr/bin/env node
// Regenerates server/src/migrations/manifest.generated.ts from the *.sql
// files sitting next to it.
//
// Why this exists at all: db.ts used to read migrations off disk at
// startup (readdirSync + readFileSync against MIGRATIONS_DIR). That's fine
// for `bun --watch src/index.ts` / `bun src/index.ts` / `bun test`, which
// all run against a real source tree, but issue #102's compiled binary has
// no source tree beside it — `bun build --compile` only embeds a file it
// can see referenced through a *static* `import … with { type: "text" }`,
// and a runtime directory scan can't produce one of those. This script
// writes out one explicit import per migration file so bun build has
// something to embed, and an array pairing each with its version number
// so db.ts doesn't have to parse filenames anymore.
//
// Run: `npm --prefix server run generate:migrations` after adding,
// renaming, or removing a file in server/src/migrations/. CI (check.yml)
// re-runs this and fails the build if it produces a diff, so a forgotten
// regen is caught before it ever reaches a compiled binary — see db.ts's
// comment on MIGRATIONS for what happens if it's skipped anyway.

import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "migrations");
const OUT_FILE = path.join(MIGRATIONS_DIR, "manifest.generated.ts");

// Exported (not just run as a top-level script) so scripts/compile.ts can
// call this directly before every real release build, guaranteeing a
// compiled binary always embeds whatever's actually in src/migrations/
// right now rather than trusting someone remembered to run this by hand.
export function generateMigrationsManifest() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(`no *.sql files found in ${MIGRATIONS_DIR}`);
  }

  // "0001_init.sql" -> identifier "m0001_init", version 1. Every migration
  // file in this repo already follows this <4-digit>_<name>.sql convention
  // (see db.ts's own version parsing, which this replaced) — fail loudly on
  // anything that doesn't fit rather than silently skipping it.
  const entries = files.map((file) => {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!match) {
      throw new Error(`migration file "${file}" doesn't match NNNN_name.sql — can't derive a version/identifier from it`);
    }
    const [, digits, name] = match;
    return {
      file,
      version: Number.parseInt(digits, 10),
      identifier: `m${digits}_${name}`,
    };
  });

  const seenVersions = new Set();
  for (const entry of entries) {
    if (seenVersions.has(entry.version)) {
      throw new Error(`duplicate migration version ${entry.version} (from ${entry.file})`);
    }
    seenVersions.add(entry.version);
  }

  const importLines = entries
    .map((e) => `import ${e.identifier} from "./${e.file}" with { type: "text" };`)
    .join("\n");

  const arrayLines = entries
    .map((e) => `  { version: ${e.version}, file: ${JSON.stringify(e.file)}, sql: ${e.identifier} },`)
    .join("\n");

  const output = `// GENERATED FILE — do not edit by hand.
// Regenerate with \`npm --prefix server run generate:migrations\` after
// touching server/src/migrations/*.sql — see
// server/scripts/generate-migrations-manifest.mjs for why this exists.

${importLines}

export interface MigrationFile {
  version: number;
  file: string;
  sql: string;
}

export const MIGRATIONS: MigrationFile[] = [
${arrayLines}
];
`;

  writeFileSync(OUT_FILE, output);
  return { count: entries.length, outFile: OUT_FILE };
}

// Only run when invoked directly (`node scripts/generate-migrations-manifest.mjs`
// / `npm --prefix server run generate:migrations`), not when imported by
// scripts/compile.ts — the standard dual Node/Bun "am I the entry point"
// check, since `import.meta.main` is Bun-only and this also runs under
// plain Node (see check.yml, which has no Bun step before this point).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { count, outFile } = generateMigrationsManifest();
  console.log(`wrote ${count} migrations to ${path.relative(process.cwd(), outFile)}`);
}
