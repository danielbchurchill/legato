import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createSession, upsertUser } from "../accounts.js";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { mintPairingCode } from "../pairing.js";

async function listenApp(app: FastifyInstance): Promise<string> {
  return app.listen({ port: 0, host: "127.0.0.1" });
}

function signIn(db: Database.Database): { userId: number; cookieHeader: string } {
  const user = upsertUser(db, "google", {
    providerUserId: "pair-test-user",
    email: null,
    displayName: null,
    avatarUrl: null,
  });
  const { token } = createSession(db, user.id);
  return { userId: user.id, cookieHeader: `relay_session=${token}` };
}

describe("POST /pair/start", () => {
  let db: Database.Database;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("requires a relay session", async () => {
    app = buildApp({ db });
    const httpUrl = await listenApp(app);

    const response = await fetch(`${httpUrl}/pair/start`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("mints a code tied to the signed-in account", async () => {
    app = buildApp({ db });
    const httpUrl = await listenApp(app);
    const { cookieHeader } = signIn(db);

    const response = await fetch(`${httpUrl}/pair/start`, { method: "POST", headers: { cookie: cookieHeader } });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { code: string; expiresAt: string };
    expect(body.code).toMatch(/^[0-9a-f]{16}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("POST /pair/exchange", () => {
  let db: Database.Database;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("exchanges a valid code for a tunnel credential", async () => {
    app = buildApp({ db });
    const httpUrl = await listenApp(app);
    const { userId } = signIn(db);
    const { code } = mintPairingCode(db, userId);

    const response = await fetch(`${httpUrl}/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { credential: string; expiresAt: string };
    expect(body.credential).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an already-used code", async () => {
    app = buildApp({ db });
    const httpUrl = await listenApp(app);
    const { userId } = signIn(db);
    const { code } = mintPairingCode(db, userId);

    const first = await fetch(`${httpUrl}/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${httpUrl}/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(second.status).toBe(410);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/used/);
  });

  it("rejects an expired code", async () => {
    app = buildApp({ db });
    const httpUrl = await listenApp(app);
    const { userId } = signIn(db);
    db.prepare(
      "INSERT INTO pairing_codes (code, relay_user_id, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))",
    ).run("expired-code", userId);

    const response = await fetch(`${httpUrl}/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "expired-code" }),
    });

    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/expired/);
  });

  it("rejects an unknown code", async () => {
    app = buildApp({ db });
    const httpUrl = await listenApp(app);

    const response = await fetch(`${httpUrl}/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "not-a-real-code" }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects a missing code", async () => {
    app = buildApp({ db });
    const httpUrl = await listenApp(app);

    const response = await fetch(`${httpUrl}/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });
});
