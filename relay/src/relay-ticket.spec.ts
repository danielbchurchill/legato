import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
// The home server's real verifier: a relay ticket must be worthless to one.
import { importEd25519Jwk, verifyLegatoToken } from "../../server/src/auth/legatoToken.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { removeLinkedServer } from "./linked-servers.js";
import type { RequestFrame } from "./protocol.js";
import { redactCredentials } from "./routes/relay.js";
import {
  parseSigningKeys,
  RELAY_TICKET_TTL_SECONDS,
  signRelayTicket,
  signServerToken,
  verifyRelayTicket,
  type SigningKeys,
} from "./signing-keys.js";
import { linkServer, listenApp, signIn } from "./testing/tunnel-harness.js";
import { getUserById } from "./accounts.js";

// Issue #365: a device reaches a home server through /relay/<id>/ with a
// relay ticket for that server, and Legato's own clients call it
// cross-origin.

const ISSUER = "https://auth.legato.test";
const APP_ORIGIN = "tauri://localhost";

function signingKeys(): SigningKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  return parseSigningKeys(JSON.stringify([{ privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) }]))!;
}

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  while (apps.length) await apps.pop()!.close();
});

function setup(keys: SigningKeys | null = signingKeys()) {
  const db = openDb(":memory:");
  const app = buildApp({ db, auth: { config: { callbackBaseUrl: ISSUER }, signingKeys: keys } });
  apps.push(app);
  return { db, app, keys: keys! };
}

// A tunnel that records every request frame and answers each with 200 and
// the frame's path, as a home server would answer anything.
async function homeServer(tunnelUrl: string, credential: string) {
  const socket = new WebSocket(tunnelUrl);
  sockets.push(socket);
  const frames: RequestFrame[] = [];
  await new Promise<void>((resolve) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credential })));
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as RequestFrame | { type: string };
      if (frame.type === "auth-ok") resolve();
      if (frame.type !== "request") return;
      const request = frame as RequestFrame;
      frames.push(request);
      const send = (out: object) => socket.send(JSON.stringify({ requestId: request.requestId, ...out }));
      send({ type: "response-start", status: 200, headers: { "content-type": "text/plain", "x-cover-source": "embedded" } });
      send({ type: "response-chunk", data: Buffer.from(request.path).toString("base64") });
      send({ type: "response-end" });
    });
  });
  return frames;
}

async function connected(keys: SigningKeys | null = signingKeys()) {
  const { db, app } = setup(keys);
  const { httpUrl, tunnelUrl } = await listenApp(app);
  const account = signIn(db);
  const { serverId, credential } = linkServer(db, account.userId);
  const frames = await homeServer(tunnelUrl, credential);
  const user = getUserById(db, account.userId)!;
  const ticket = keys ? signRelayTicket(keys, { issuer: ISSUER, user, serverId }).ticket : "";
  return { db, httpUrl, account, serverId, frames, user, ticket };
}

describe("relay tickets", () => {
  it("names one account and one server, for twelve hours, and nothing else", () => {
    const keys = signingKeys();
    const db = openDb(":memory:");
    const user = getUserById(db, signIn(db).userId)!;
    const serverId = "a".repeat(32);
    const now = 1_800_000_000;
    const { ticket, expiresAt } = signRelayTicket(keys, { issuer: ISSUER, user, serverId, nowSeconds: now });
    expect(expiresAt.getTime()).toBe((now + RELAY_TICKET_TTL_SECONDS) * 1000);

    const claims = JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toEqual({
      iss: ISSUER,
      sub: String(user.id),
      aud: serverId,
      iat: now,
      exp: now + RELAY_TICKET_TTL_SECONDS,
      scope: "relay",
    });

    expect(verifyRelayTicket(keys, ticket, { issuer: ISSUER, serverId, nowSeconds: now })).toEqual({ accountId: user.id });
    // Another server, too late, another issuer, another key.
    expect(verifyRelayTicket(keys, ticket, { issuer: ISSUER, serverId: "b".repeat(32), nowSeconds: now })).toBeNull();
    expect(verifyRelayTicket(keys, ticket, { issuer: ISSUER, serverId, nowSeconds: now + RELAY_TICKET_TTL_SECONDS })).toBeNull();
    expect(verifyRelayTicket(keys, ticket, { issuer: "https://elsewhere.test", serverId, nowSeconds: now })).toBeNull();
    expect(verifyRelayTicket(signingKeys(), ticket, { issuer: ISSUER, serverId, nowSeconds: now })).toBeNull();
    // A server token for the same pair isn't a ticket.
    const access = signServerToken(keys, { issuer: ISSUER, user, serverId, scope: "access", nowSeconds: now }).token;
    expect(verifyRelayTicket(keys, access, { issuer: ISSUER, serverId, nowSeconds: now })).toBeNull();
  });

  // Twelve hours is past the fifteen minutes a home server accepts, and
  // "relay" isn't a scope it knows.
  it("is refused by a home server, so one that leaked there opens nothing", () => {
    const keys = signingKeys();
    const db = openDb(":memory:");
    const user = getUserById(db, signIn(db).userId)!;
    const serverId = "a".repeat(32);
    const { ticket } = signRelayTicket(keys, { issuer: ISSUER, user, serverId });
    const serverKeys = new Map(keys.published.map((jwk) => [jwk.kid, importEd25519Jwk(jwk)!.key]));
    expect(verifyLegatoToken(ticket, { keys: serverKeys, issuer: ISSUER, audience: serverId })).toEqual({
      ok: false,
      reason: "lifetime_too_long",
    });
  });
});

describe("POST /auth/relay-ticket", () => {
  it("signs a ticket only for a server the signed-in account has linked", async () => {
    const { db, app, keys } = setup();
    const account = signIn(db);
    const { serverId } = linkServer(db, account.userId);
    const post = (body: unknown, token: string | null = account.token) =>
      app.inject({
        method: "POST",
        url: "/auth/relay-ticket",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        payload: JSON.stringify(body),
      });

    expect((await post({ serverId }, null)).statusCode).toBe(401);
    expect((await post({ serverId: "nope" })).json()).toMatchObject({ reason: "bad_server_id" });
    expect((await post({ serverId: "c".repeat(32) })).json()).toMatchObject({ reason: "not_linked" });
    expect((await post({ serverId: "c".repeat(32) })).statusCode).toBe(404);

    const response = await post({ serverId });
    expect(response.statusCode).toBe(200);
    const { ticket, expiresAt } = response.json() as { ticket: string; expiresAt: string };
    expect(verifyRelayTicket(keys, ticket, { issuer: ISSUER, serverId })).toEqual({ accountId: account.userId });
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now() + (RELAY_TICKET_TTL_SECONDS - 60) * 1000);
  });

  it("says so when this relay doesn't sign", async () => {
    const { db, app } = setup(null);
    const account = signIn(db);
    const { serverId } = linkServer(db, account.userId);
    const response = await app.inject({
      method: "POST",
      url: "/auth/relay-ticket",
      headers: { "content-type": "application/json", authorization: `Bearer ${account.token}` },
      payload: JSON.stringify({ serverId }),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ reason: "signing_not_configured" });
  });

  it("answers the desktop webview's CORS, and no other origin's", async () => {
    const { app } = setup();
    const preflight = (origin: string) =>
      app.inject({ method: "OPTIONS", url: "/auth/relay-ticket", headers: { origin, "access-control-request-method": "POST" } });
    expect((await preflight(APP_ORIGIN)).headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expect((await preflight("https://elsewhere.example")).headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("/relay/<id>/ with a relay ticket", () => {
  it("lets a ticket in from its header or its query, and takes it off before the server sees the request", async () => {
    const { httpUrl, serverId, ticket, frames } = await connected();

    const viaHeader = await fetch(`${httpUrl}/relay/${serverId}/api/v1/stats?b=2`, { headers: { "x-legato-relay": ticket } });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.text()).toBe("/api/v1/stats?b=2");

    // Every other parameter goes through exactly as the device encoded it,
    // a home server's own media ticket among them.
    const query = `quality=opus160&relay=${ticket}&t=media%2Bticket&q=%E6%97%A5`;
    const viaQuery = await fetch(`${httpUrl}/relay/${serverId}/api/v1/files/1/stream?${query}`);
    expect(viaQuery.status).toBe(200);
    expect(await viaQuery.text()).toBe("/api/v1/files/1/stream?quality=opus160&t=media%2Bticket&q=%E6%97%A5");

    const alone = await fetch(`${httpUrl}/relay/${serverId}/api/v1/events?relay=${ticket}`);
    expect(await alone.text()).toBe("/api/v1/events");

    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.headers["x-legato-relay"]).toBeUndefined();
      expect(JSON.stringify(frame)).not.toContain(ticket);
    }
  });

  it("passes the device's own Authorization through for the home server to check", async () => {
    const { httpUrl, serverId, ticket, frames } = await connected();
    await fetch(`${httpUrl}/relay/${serverId}/api/v1/library-roots`, {
      headers: { "x-legato-relay": ticket, authorization: "Bearer server-session" },
    });
    expect(frames[0]!.headers.authorization).toBe("Bearer server-session");
  });

  it("refuses a ticket for another server, an expired one, one from another key, and an access token", async () => {
    const keys = signingKeys();
    const { db, httpUrl, serverId, user, frames } = await connected(keys);
    const other = linkServer(db, user.id).serverId;
    const past = Math.floor(Date.now() / 1000) - RELAY_TICKET_TTL_SECONDS - 1;
    const refused = [
      signRelayTicket(keys, { issuer: ISSUER, user, serverId: other }).ticket,
      signRelayTicket(keys, { issuer: ISSUER, user, serverId, nowSeconds: past }).ticket,
      signRelayTicket(signingKeys(), { issuer: ISSUER, user, serverId }).ticket,
      signServerToken(keys, { issuer: ISSUER, user, serverId, scope: "access" }).token,
      "not-a-ticket",
    ];
    for (const ticket of refused) {
      const response = await fetch(`${httpUrl}/relay/${serverId}/x`, { headers: { "x-legato-relay": ticket } });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: "relay_signed_out" });
    }
    expect(frames).toHaveLength(0);
  });

  it("stops letting a ticket in the moment its server is unlinked", async () => {
    const { db, httpUrl, serverId, ticket, account } = await connected();
    expect((await fetch(`${httpUrl}/relay/${serverId}/x`, { headers: { "x-legato-relay": ticket } })).status).toBe(200);
    removeLinkedServer(db, account.userId, serverId);
    expect((await fetch(`${httpUrl}/relay/${serverId}/x`, { headers: { "x-legato-relay": ticket } })).status).toBe(404);
  });

  it("refuses every ticket when this relay doesn't sign", async () => {
    const { httpUrl, serverId } = await connected(null);
    const forged = signRelayTicket(signingKeys(), { issuer: ISSUER, user: { id: 1 } as never, serverId }).ticket;
    expect((await fetch(`${httpUrl}/relay/${serverId}/x`, { headers: { "x-legato-relay": forged } })).status).toBe(401);
  });
});

describe("/relay/<id>/ CORS", () => {
  it("answers a preflight from Legato's own clients itself, without forwarding it", async () => {
    const { httpUrl, serverId, frames } = await connected();
    const preflight = (origin: string) =>
      fetch(`${httpUrl}/relay/${serverId}/api/v1/playlists`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, x-legato-relay" },
      });

    for (const origin of [APP_ORIGIN, "http://tauri.localhost", "http://127.0.0.1:5187"]) {
      const response = await preflight(origin);
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-headers")).toContain("X-Legato-Relay");
      expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    const stranger = await preflight("https://elsewhere.example");
    expect(stranger.status).toBe(204);
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
    expect(stranger.headers.get("access-control-allow-headers")).toBeNull();
    expect(frames).toHaveLength(0);
  });

  it("lets Legato's own clients read an answer, the relay's refusals included, and no one else", async () => {
    const { httpUrl, serverId, ticket } = await connected();
    const get = (origin: string, headers: Record<string, string> = { "x-legato-relay": ticket }) =>
      fetch(`${httpUrl}/relay/${serverId}/x`, { headers: { origin, ...headers } });

    const ok = await get(APP_ORIGIN);
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(ok.headers.get("access-control-expose-headers")).toContain("X-Cover-Source");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    expect(ok.headers.get("vary")).toBe("Origin");
    expect(ok.headers.get("content-security-policy")).toBe("sandbox");

    const refused = await get(APP_ORIGIN, {});
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);

    const stranger = await get("https://elsewhere.example");
    expect(stranger.status).toBe(200);
    expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the relay's request log", () => {
  it("never holds a relay ticket or a media ticket", () => {
    expect(redactCredentials("/relay/abc/api/v1/files/1/stream?quality=opus160&relay=a.b.c&t=xyz")).toBe(
      "/relay/abc/api/v1/files/1/stream?quality=opus160&relay=[redacted]&t=[redacted]",
    );
    expect(redactCredentials("/relay/abc/api/v1/events?t=xyz&relay=a.b.c")).toBe("/relay/abc/api/v1/events?t=[redacted]&relay=[redacted]");
    expect(redactCredentials("/relay/abc/api/v1/search?q=relay")).toBe("/relay/abc/api/v1/search?q=relay");
  });
});
