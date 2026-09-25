import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "bun:test";
import { MIGRATIONS } from "./manifest.generated.js";

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Issue #174: manifest.generated.ts is a static import list bun build
// --compile can embed (see generate-migrations-manifest.mjs's own comment
// on why it exists) — nothing enforces that it still matches the *.sql
// files actually on disk once a migration lands without a regen. check.yml
// catches that in CI, but CI is blocked on billing right now (#174), so
// this is the only thing that still catches it before a compiled binary
// silently applies fewer migrations than exist.
describe("migrations manifest", () => {
  it("lists exactly the *.sql files present in server/src/migrations/", () => {
    const diskFiles = new Set(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")));
    const manifestFiles = new Set(MIGRATIONS.map((m) => m.file));

    const missingFromManifest = [...diskFiles].filter((f) => !manifestFiles.has(f)).sort();
    const extraInManifest = [...manifestFiles].filter((f) => !diskFiles.has(f)).sort();

    if (missingFromManifest.length === 0 && extraInManifest.length === 0) {
      return;
    }

    const problems: string[] = [];
    if (missingFromManifest.length > 0) {
      problems.push(`on disk but missing from the manifest: ${missingFromManifest.join(", ")}`);
    }
    if (extraInManifest.length > 0) {
      problems.push(`in the manifest but no longer on disk: ${extraInManifest.join(", ")}`);
    }

    throw new Error(
      `server/src/migrations/manifest.generated.ts is stale (${problems.join("; ")}). ` +
        "Run `npm --prefix server run generate:migrations` and commit the result.",
    );
  });
});
