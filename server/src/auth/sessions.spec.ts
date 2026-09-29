import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import { MIGRATIONS } from "../migrations/manifest.generated.js";
import { openSqlite } from "../sqlite.js";
import { createSession, deleteSession, hashToken, userForMediaTicket, userForSessionToken } from "./sessions.js";
import { SignInLimiter } from "./rateLimit.js";

let db: Database;
let ownerId: number;

beforeEach(() => {
  db = openDb(":memory:");
  db.prepare(
    "INSERT INTO users (provider, provider_user_id, password_hash, role) VALUES ('local', 'owner', 'x', 'owner')",
  ).run();
  ownerId = (db.prepare("SELECT id FROM users").get() as { id: number }).id;
});

describe("sessions", () => {
  it("resolves a fresh session back to its user", () => {
    const { token, expiresAt } = createSession(db, ownerId);
    expect(userForSessionToken(db, token)?.id).toBe(ownerId);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  });

  it("stores only hashes, so a copied database signs nobody in", () => {
    const { token, mediaTicket } = createSession(db, ownerId);
    const row = db.prepare("SELECT * FROM sessions").get() as Record<string, string>;
    expect(Object.values(row)).not.toContain(token);
    expect(Object.values(row)).not.toContain(mediaTicket);
    expect(userForSessionToken(db, row.token_hash!)).toBeNull();
    expect(row.token_hash).toBe(hashToken(token));
  });

  it("rejects a token that was never issued, or one character off", () => {
    const { token } = createSession(db, ownerId);
    expect(userForSessionToken(db, "not-a-real-token")).toBeNull();
    expect(userForSessionToken(db, `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(userForSessionToken(db, "")).toBeNull();
  });

  it("rejects an expired session", () => {
    const { token, mediaTicket } = createSession(db, ownerId);
    db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 second')").run();
    expect(userForSessionToken(db, token)).toBeNull();
    expect(userForMediaTicket(db, mediaTicket)).toBeNull();
  });

  it("slides expiry forward on use, at most once a day", () => {
    const { token } = createSession(db, ownerId);
    db.prepare(
      "UPDATE sessions SET expires_at = datetime('now', '+2 days'), refreshed_at = datetime('now', '-2 days')",
    ).run();
    userForSessionToken(db, token);
    const after = db.prepare("SELECT expires_at > datetime('now', '+29 days') AS slid FROM sessions").get() as {
      slid: number;
    };
    expect(after.slid).toBe(1);

    db.prepare("UPDATE sessions SET expires_at = datetime('now', '+2 days')").run();
    userForSessionToken(db, token);
    const again = db.prepare("SELECT expires_at < datetime('now', '+3 days') AS held FROM sessions").get() as {
      held: number;
    };
    expect(again.held).toBe(1);
  });

  it("signing out kills the token and its media ticket together", () => {
    const { token, mediaTicket } = createSession(db, ownerId);
    deleteSession(db, token);
    expect(userForSessionToken(db, token)).toBeNull();
    expect(userForMediaTicket(db, mediaTicket)).toBeNull();
  });
});

describe("SignInLimiter", () => {
  it("allows five failures, then locks out with a doubling wait capped at 15 minutes", () => {
    let now = 0;
    const limiter = new SignInLimiter(() => now);
    for (let i = 0; i < 4; i++) limiter.recordFailure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(0);
    limiter.recordFailure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(60);
    now += 61_000;
    limiter.recordFailure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(120);
    for (let i = 0; i < 10; i++) limiter.recordFailure("a");
    expect(limiter.retryAfterSeconds("a")).toBe(15 * 60);
  });

  it("clears an address on success", () => {
    const limiter = new SignInLimiter(() => 0);
    for (let i = 0; i < 5; i++) limiter.recordFailure("a");
    limiter.recordSuccess("a");
    expect(limiter.retryAfterSeconds("a")).toBe(0);
  });

  it("locks everyone out when guesses are spread across many addresses", () => {
    let now = 0;
    const limiter = new SignInLimiter(() => now);
    for (let i = 0; i < 30; i++) limiter.recordFailure(`10.0.0.${i}`);
    expect(limiter.retryAfterSeconds("10.0.1.1")).toBeGreaterThan(0);
    now += 60_001;
    expect(limiter.retryAfterSeconds("10.0.1.1")).toBe(0);
  });
});

// The upgrade path, run against an on-disk database built the way a
// pre-0029 release left it.
describe("migration 0029 on an existing server", () => {
  let dataDir: string | undefined;
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("keeps Google/GitHub users as legacy, drops their old sessions, and has no owner", () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "legato-0029-"));
    const dbPath = path.join(dataDir, "legato.db");
    const old = openSqlite(dbPath);
    old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
    for (const { version, sql } of MIGRATIONS) {
      if (version >= 29) break;
      old.exec(sql);
      old.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    }
    old.prepare("INSERT INTO users (provider, provider_user_id, email) VALUES ('google', 'g-1', 'd@example.com')").run();
    old.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('raw-token', 1, '2099-01-01')").run();
    old.close();

    const upgraded = openDb(dbPath, { log: () => {} });
    const users = upgraded.prepare("SELECT provider, provider_user_id, email, role FROM users").all();
    expect(users).toEqual([{ provider: "google", provider_user_id: "g-1", email: "d@example.com", role: "legacy" }]);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(upgraded.prepare("SELECT 1 FROM users WHERE role = 'owner'").get()).toBeUndefined();
    upgraded.close();
  });

  it("refuses a second owner at the database level", () => {
    expect(() =>
      db
        .prepare("INSERT INTO users (provider, provider_user_id, password_hash, role) VALUES ('local', 'owner2', 'x', 'owner')")
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("refuses a password on an OAuth row, and a local row without one", () => {
    expect(() =>
      db.prepare("INSERT INTO users (provider, provider_user_id, password_hash, role) VALUES ('google', 'g', 'x', 'legacy')").run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO users (provider, provider_user_id, role) VALUES ('local', 'nopass', 'legacy')").run(),
    ).toThrow(/CHECK/);
  });
});
