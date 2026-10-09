import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { createSession, upsertUser } from "../accounts.js";
import { buildApp } from "../app.js";
import { openDb } from "../db.js";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { claimProof, serverIdForPublicKey, type ServerKey } from "../../../server/src/auth/serverKey.js";
import { claimServerCode } from "../pairing.js";
import { parseSigningKeys } from "../signing-keys.js";

async function listenApp(app: FastifyInstance): Promise<string> {
  return app.listen({ port: 0, host: "127.0.0.1" });
}

function signIn(db: Database): { userId: number; cookieHeader: string } {
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
  let db: Database;
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
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

// What a home server sends since issue #237: the code, signed with its
// identity key by its own signer. claim.spec.ts covers what the proof
// stops; these are the route's answers.
function homeServer(): ServerKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
  return { serverId: serverIdForPublicKey(publicKey), publicKey, privateKey };
}

const ISSUER = "http://relay.test";

// The server whose QR the account scanned: only it can redeem the claim
// (issue #324).
const SERVER = homeServer();

function exchangeBody(code: string, server = SERVER) {
  return claimProof(server, { issuer: ISSUER, code, nowSeconds: Math.floor(Date.now() / 1000) });
}

function claimFor(db: Database, userId: number, server = SERVER): { code: string } {
  const result = claimServerCode(db, userId, "K7QM-4XRD", server.serverId);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe("POST /pair/exchange", () => {
  let db: Database;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function signedApp() {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signingKeys = parseSigningKeys(JSON.stringify([{ privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) }]));
    return buildApp({ db, auth: { config: { callbackBaseUrl: ISSUER }, signingKeys } });
  }

  const exchange = (body: unknown) =>
    app!.inject({ method: "POST", url: "/pair/exchange", headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });

  it("exchanges a valid code for a link token for the redeeming server", async () => {
    app = signedApp();
    const { userId } = signIn(db);
    const server = homeServer();
    const { code } = claimFor(db, userId, server);

    const response = await exchange(exchangeBody(code, server));
    expect(response.statusCode).toBe(200);
    const { linkToken } = response.json() as { linkToken: string };
    const claims = JSON.parse(Buffer.from(linkToken.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: String(userId), aud: server.serverId, scope: "link", tunnel: true, iss: ISSUER });
  });

  it("rejects an already-used code", async () => {
    app = signedApp();
    const { userId } = signIn(db);
    const { code } = claimFor(db, userId);

    expect((await exchange(exchangeBody(code))).statusCode).toBe(200);
    const second = await exchange(exchangeBody(code));
    expect(second.statusCode).toBe(410);
    expect(second.json()).toMatchObject({ reason: "used" });
  });

  it("rejects an expired code", async () => {
    app = signedApp();
    const { userId } = signIn(db);
    db.prepare(
      "INSERT INTO pairing_codes (code, relay_user_id, server_id, expires_at) VALUES (?, ?, ?, datetime('now', '-1 minute'))",
    ).run("EXPD-0000", userId, SERVER.serverId);

    // Typed the way a person would: lowercase, no dash, O for 0. The
    // proof signs the code as the server shows it.
    const body = { ...exchangeBody("EXPD-0000"), code: "expdoooo" };
    const response = await exchange(body);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ reason: "expired" });
  });

  it("answers 404 for a code nobody has claimed yet", async () => {
    app = signedApp();
    const response = await exchange(exchangeBody("K7QM-4XRD"));
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ reason: "not_found" });
  });

  it("rejects a code with no proof, without spending it", async () => {
    app = signedApp();
    const { userId } = signIn(db);
    const { code } = claimFor(db, userId);

    expect((await exchange({ code })).statusCode).toBe(400);
    expect((await exchange({})).statusCode).toBe(400);
    expect((await exchange(exchangeBody(code))).statusCode).toBe(200);
  });

  it("refuses while this relay can't sign tokens, without spending the code", async () => {
    app = buildApp({ db, auth: { config: { callbackBaseUrl: ISSUER }, signingKeys: null } });
    const { userId } = signIn(db);
    const { code } = claimFor(db, userId);

    const response = await exchange(exchangeBody(code));
    expect(response.statusCode).toBe(503);
    expect(db.prepare("SELECT used_at FROM pairing_codes WHERE code = ?").get(code)).toEqual({ used_at: null });
  });
});
