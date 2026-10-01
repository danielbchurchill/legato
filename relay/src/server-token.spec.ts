import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
// The home server's real verifier, not a copy: the point of these tests is
// that what this relay signs is exactly what a server accepts.
import { importEd25519Jwk, verifyLegatoToken } from "../../server/src/auth/legatoToken.js";
import { createSession, upsertUser } from "./accounts.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { jwkThumbprint, parseSigningKeys, SERVER_TOKEN_TTL_SECONDS, type SigningKeys } from "./signing-keys.js";
import type { Database } from "./sqlite.js";

const ISSUER = "https://auth.legato.test";
const SERVER_ID = "0123456789abcdef0123456789abcdef";

function keyEntry() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) as string };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function setup(signingKeys: SigningKeys | null, callbackBaseUrl: string | undefined = ISSUER) {
  const db = openDb(":memory:");
  const app = buildApp({ db, auth: { config: { callbackBaseUrl }, signingKeys } });
  apps.push(app);
  return { db, app };
}

function signIn(db: Database, emailVerified = true) {
  const user = upsertUser(db, "google", {
    providerUserId: "g-1",
    email: "owner@example.com",
    emailVerified,
    displayName: "Owner",
    avatarUrl: null,
  });
  return { user, token: createSession(db, user.id).token };
}

function serverKeys(published: SigningKeys["published"]) {
  return new Map(published.map((jwk) => [jwk.kid, importEd25519Jwk(jwk)!.key]));
}

describe("parseSigningKeys", () => {
  it("is null when unset, and signs with the first of several keys while publishing all", () => {
    expect(parseSigningKeys(undefined)).toBeNull();
    expect(parseSigningKeys("  ")).toBeNull();
    const keys = parseSigningKeys(JSON.stringify([keyEntry(), keyEntry()]))!;
    expect(keys.published).toHaveLength(2);
    expect(keys.signing.kid).toBe(keys.published[0]!.kid);
    for (const jwk of keys.published) {
      expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
      expect(jwk.kid).toBe(jwkThumbprint(jwk.x));
      expect(JSON.stringify(jwk)).not.toContain('"d"');
    }
  });

  it("names what's wrong without echoing key material", () => {
    expect(() => parseSigningKeys("not json")).toThrow(/valid JSON/);
    expect(() => parseSigningKeys("[]")).toThrow(/non-empty/);
    expect(() => parseSigningKeys('[{"privateKey":"secret-ish garbage"}]')).toThrow(/entry 0 isn't a readable/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
    expect(() => parseSigningKeys(JSON.stringify([{ privateKey: rsa }]))).toThrow(/rsa key; only Ed25519/);
  });
});

describe("GET /.well-known/jwks.json", () => {
  it("publishes every key, cacheably", async () => {
    const keys = parseSigningKeys(JSON.stringify([keyEntry(), keyEntry()]))!;
    const { app } = setup(keys);
    const res = await app.inject({ url: "/.well-known/jwks.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.json()).toEqual({ keys: keys.published });
  });

  it("is an empty set when signing is off, and the relay still serves", async () => {
    const { app } = setup(null);
    expect((await app.inject({ url: "/.well-known/jwks.json" })).json()).toEqual({ keys: [] });
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });
});

describe("POST /auth/server-token", () => {
  it("signs a link token the home server's verifier accepts", async () => {
    const keys = parseSigningKeys(JSON.stringify([keyEntry()]))!;
    const { db, app } = setup(keys);
    const { user, token } = signIn(db);

    const res = await app.inject({
      method: "POST",
      url: "/auth/server-token",
      headers: { authorization: `Bearer ${token}` },
      payload: { serverId: SERVER_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; expiresAt: string; scope: string };
    expect(body.scope).toBe("link");

    const verified = verifyLegatoToken(body.token, { keys: serverKeys(keys.published), issuer: ISSUER, audience: SERVER_ID });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({
      iss: ISSUER,
      sub: String(user.id),
      aud: SERVER_ID,
      scope: "link",
      email: "owner@example.com",
      emailVerified: true,
      name: "Owner",
    });
    expect(verified.claims.exp - verified.claims.iat).toBe(SERVER_TOKEN_TTL_SECONDS);
    expect(Date.parse(body.expiresAt)).toBe(verified.claims.exp * 1000);

    // Another server refuses it.
    const elsewhere = verifyLegatoToken(body.token, {
      keys: serverKeys(keys.published),
      issuer: ISSUER,
      audience: "f".repeat(32),
    });
    expect(elsewhere).toEqual({ ok: false, reason: "wrong_audience" });
  });

  it("says email_verified: false when the provider didn't vouch for the address", async () => {
    const keys = parseSigningKeys(JSON.stringify([keyEntry()]))!;
    const { db, app } = setup(keys);
    const { token } = signIn(db, false);
    const res = await app.inject({
      method: "POST",
      url: "/auth/server-token",
      headers: { authorization: `Bearer ${token}` },
      payload: { serverId: SERVER_ID },
    });
    const payload = JSON.parse(Buffer.from(res.json().token.split(".")[1], "base64url").toString());
    expect(payload.email_verified).toBe(false);
  });

  it("works from the browser session cookie too", async () => {
    const keys = parseSigningKeys(JSON.stringify([keyEntry()]))!;
    const { db, app } = setup(keys);
    const { token } = signIn(db);
    const res = await app.inject({
      method: "POST",
      url: "/auth/server-token",
      cookies: { relay_session: token },
      payload: { serverId: SERVER_ID },
    });
    expect(res.statusCode).toBe(200);
  });

  it("401s signed out, 400s a malformed server id, 503s with signing off", async () => {
    const keys = parseSigningKeys(JSON.stringify([keyEntry()]))!;
    const { db, app } = setup(keys);
    const { token } = signIn(db);
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "POST", url: "/auth/server-token", payload: { serverId: SERVER_ID } })).statusCode).toBe(401);
    for (const serverId of [undefined, "", "ABCDEF0123456789ABCDEF0123456789", "0123", 42]) {
      const res = await app.inject({ method: "POST", url: "/auth/server-token", headers, payload: { serverId } });
      expect(res.statusCode).toBe(400);
    }

    const off = setup(null);
    const offUser = signIn(off.db);
    const res = await off.app.inject({
      method: "POST",
      url: "/auth/server-token",
      headers: { authorization: `Bearer ${offUser.token}` },
      payload: { serverId: SERVER_ID },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("RELAY_SIGNING_KEYS");
  });

  it("answers the desktop webview's CORS preflight", async () => {
    const { app } = setup(null);
    const res = await app.inject({
      method: "OPTIONS",
      url: "/auth/server-token",
      headers: { origin: "tauri://localhost", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("tauri://localhost");
  });
});

describe("relay_users.email_verified (migration 0004)", () => {
  it("is stored on sign-in and refreshed on the next one", () => {
    const db = openDb(":memory:");
    expect(signIn(db, false).user.email_verified).toBe(0);
    expect(signIn(db, true).user.email_verified).toBe(1);
    const noEmail = upsertUser(db, "github", { providerUserId: "x", email: null, emailVerified: true, displayName: null, avatarUrl: null });
    expect(noEmail.email_verified).toBe(0);
  });
});
