import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { MIGRATIONS } from "../migrations/manifest.generated.js";
import { GIT_SHA, VERSION } from "../version.js";
import { checkForUpdates, type UpdateCheckOptions } from "../update/check.js";
import { healthRoutes, highestAppliedMigration, type HealthBody } from "./health.js";

// Issue #193. Clients decide "this server is too old for me" from these
// fields alone, so the shape is pinned here rather than left to whatever
// the handler happens to return. libraryRoots' contents are #192's and are
// covered in scan/reachability.spec.ts.

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

async function getHealth(update: UpdateCheckOptions = {}) {
  const app = Fastify();
  await app.register(healthRoutes(db, update), { prefix: "/api/v1" });
  return app.inject({ method: "GET", url: "/api/v1/health" });
}

describe("GET /api/v1/health", () => {
  it("reports status, version, gitSha, schemaVersion, libraryRoots, installChannel and update", async () => {
    const res = await getHealth();

    expect(res.statusCode).toBe(200);
    const body = res.json() as HealthBody;
    expect(Object.keys(body).sort()).toEqual([
      "gitSha",
      "installChannel",
      "libraryRoots",
      "schemaVersion",
      "status",
      "update",
      "version",
    ]);
    expect(body.status).toBe("ok");
    expect(Array.isArray(body.libraryRoots)).toBe(true);
  });

  it("uses the same version and gitSha as `legato-server --version`", async () => {
    const body = (await getHealth()).json() as HealthBody;

    expect(body.version).toBe(VERSION);
    expect(body.gitSha).toBe(GIT_SHA);
  });

  it("reports the highest migration applied, as a number", async () => {
    const body = (await getHealth()).json() as HealthBody;

    expect(body.schemaVersion).toBe(Math.max(...MIGRATIONS.map(({ version }) => version)));
  });

  // Issue #110: the update fields the client turns into a notice. The check
  // itself is covered in update/check.spec.ts.
  it("reports the install channel and the last update check's answer", async () => {
    const update: UpdateCheckOptions = {
      env: { LEGATO_INSTALL_CHANNEL: "docker" },
      version: "0.3.0",
      now: () => new Date("2026-10-01T09:00:00Z"),
      fetch: async () => new Response(JSON.stringify([{ tag_name: "v0.4.0", html_url: "https://example.test/v0.4.0" }])),
    };
    await checkForUpdates(db, update);

    const body = (await getHealth(update)).json() as HealthBody;

    expect(body.installChannel).toBe("docker");
    expect(body.update).toEqual({
      check: "on",
      latestVersion: "0.4.0",
      available: true,
      releaseUrl: "https://example.test/v0.4.0",
      checkedAt: "2026-10-01T09:00:00.000Z",
    });
  });

  it("reports an unset channel as unknown", async () => {
    const body = (await getHealth({ env: {} })).json() as HealthBody;

    expect(body.installChannel).toBe("unknown");
  });
});

describe("highestAppliedMigration", () => {
  it("reads the highest applied version, not the count of rows", () => {
    db.prepare("DELETE FROM schema_migrations WHERE version = 1").run();

    expect(highestAppliedMigration(db)).toBe(Math.max(...MIGRATIONS.map(({ version }) => version)));
  });

  it("is 0 when nothing has been applied", () => {
    db.prepare("DELETE FROM schema_migrations").run();

    expect(highestAppliedMigration(db)).toBe(0);
  });
});
