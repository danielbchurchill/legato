import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
// The home server's real statement signer: what a web client brings here
// has to be exactly what its server signs.
import { serverIdForPublicKey, webClientStatement, type ServerKey } from "../../server/src/auth/serverKey.js";
import { createSession, upsertUser } from "./accounts.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { mintLinkCode, parseLinkRequest } from "./link-codes.js";
import { removeLinkedServer } from "./linked-servers.js";
import { s256Challenge } from "./native-sign-in.js";
import { connectReturnPath } from "./web-sessions.js";
import { parseSigningKeys, type SigningKeys } from "./signing-keys.js";

// Issue #365: a web client a home server served signs in to legato.fm
// through /connect, with a statement its server signed, and gets a session
// that reaches that one server.

const ISSUER = "http://relay.test";
const HOME = "http://192.168.1.20:8899";

function signingKeys(): SigningKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  return parseSigningKeys(JSON.stringify([{ privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) }]))!;
}

function homeServer(): ServerKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
  return { serverId: serverIdForPublicKey(publicKey), publicKey, privateKey };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function setup() {
  const db = openDb(":memory:");
  const keys = signingKeys();
  const app = buildApp({
    db,
    auth: { config: { callbackBaseUrl: ISSUER, githubClientId: "id", githubClientSecret: "secret" }, signingKeys: keys },
  });
  apps.push(app);

  const signIn = (providerUserId = "g-1", displayName = "Rowan") => {
    const user = upsertUser(db, "google", {
      providerUserId,
      email: `${providerUserId}@example.com`,
      emailVerified: true,
      displayName,
      avatarUrl: null,
    });
    return { user, cookie: `relay_session=${createSession(db, user.id).token}` };
  };
  // The pair a link leaves, with the key the server proved.
  const link = (userId: number, server: ServerKey) =>
    db
      .prepare("INSERT INTO linked_servers (relay_user_id, server_id, public_key) VALUES (?, ?, ?)")
      .run(userId, server.serverId, server.publicKey);

  // What the web client does before it leaves: a verifier it keeps, the
  // statement its server signs for its challenge, and the query it sends.
  const start = (server: ServerKey, options: { origin?: string; nowSeconds?: number; name?: string } = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const origin = options.origin ?? HOME;
    const statement = webClientStatement(server, {
      origin,
      codeChallenge: s256Challenge(verifier),
      name: options.name ?? "musicbox",
      nowSeconds: options.nowSeconds ?? Math.floor(Date.now() / 1000),
    });
    const query = {
      server: statement.serverId,
      return_to: `${origin}/`,
      code_challenge: statement.codeChallenge,
      name: statement.name,
      expires: String(statement.expiresAt),
      signature: statement.signature,
    };
    return { verifier, query, url: `/connect?${new URLSearchParams(query)}` };
  };
  const page = (url: string, cookie?: string) => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
  const press = (cookie: string, body: Record<string, unknown>, origin: string = ISSUER) =>
    app.inject({
      method: "POST",
      url: "/connect",
      headers: { cookie, origin, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  const redeem = (code: string, verifier: string, origin: string = HOME) =>
    app.inject({
      method: "POST",
      url: "/connect/redeem",
      headers: { origin, "content-type": "application/json" },
      payload: JSON.stringify({ code, code_verifier: verifier }),
    });
  const codeFrom = (redirect: string) => new URLSearchParams(new URL(redirect).hash.slice(1)).get("legato_connect")!;

  // All the way through: signed in, linked, pressed, redeemed.
  const webSession = async (server: ServerKey, account = signIn(), origin = HOME) => {
    const flow = start(server, { origin });
    const pressed = await press(account.cookie, flow.query);
    const redeemed = await redeem(codeFrom((pressed.json() as { redirect: string }).redirect), flow.verifier, origin);
    return { account, token: (redeemed.json() as { token: string }).token, redeemed };
  };

  return { db, app, keys, signIn, link, start, page, press, redeem, codeFrom, webSession };
}

const view = (body: string) => /data-view="([a-z_]+)"/.exec(body)?.[1];

describe("GET /connect", () => {
  it("names the page's address and its server, and asks only once its server's statement holds", async () => {
    const h = setup();
    const server = homeServer();
    const flow = h.start(server);

    const signedOut = await h.page(flow.url);
    expect(view(signedOut.body)).toBe("signed_out");
    expect(signedOut.body).toContain(HOME);
    expect(signedOut.body).toContain("musicbox");
    // Signing in comes straight back here, and nowhere else.
    expect(signedOut.body).toContain(`/auth/github?return_to=${encodeURIComponent(`/connect?${new URLSearchParams(flow.query)}`)}`);
    expect(connectReturnPath(`/connect?${new URLSearchParams(flow.query)}`)).toBe(`/connect?${new URLSearchParams(flow.query)}`);
    expect(connectReturnPath("/connect?server=x")).toBeNull();

    const account = h.signIn();
    expect(view((await h.page(flow.url, account.cookie)).body)).toBe("not_linked");

    h.link(account.user.id, server);
    const ready = await h.page(flow.url, account.cookie);
    expect(view(ready.body)).toBe("ready");
    expect(ready.body).toContain("Let the page at this address reach musicbox through legato.fm, as Rowan (g-1@example.com)?");
    expect(ready.body).toContain(`"cancel":"${HOME}/#legato_connect=cancelled"`);
    expect(ready.headers.location).toBeUndefined();
  });

  it("refuses a statement that ran out, another server's, or one for another page", async () => {
    const h = setup();
    const server = homeServer();
    const account = h.signIn();
    h.link(account.user.id, server);

    const old = h.start(server, { nowSeconds: Math.floor(Date.now() / 1000) - 600 });
    expect(view((await h.page(old.url, account.cookie)).body)).toBe("stale");

    // Another server signed it, naming this one's id.
    const hostile = homeServer();
    const forged = h.start(hostile);
    forged.query.server = server.serverId;
    expect(view((await h.page(`/connect?${new URLSearchParams(forged.query)}`, account.cookie)).body)).toBe("stale");

    // This server signed it for one page; another page brings it.
    const elsewhere = h.start(server);
    elsewhere.query.return_to = "http://evil.example/";
    expect(view((await h.page(`/connect?${new URLSearchParams(elsewhere.query)}`, account.cookie)).body)).toBe("stale");

    expect((await h.page("/connect?server=nope", account.cookie)).statusCode).toBe(400);
  });
});

describe("POST /connect and /connect/redeem", () => {
  it("sends a one-time code back to the page, which buys a session for that server, from that page only", async () => {
    const h = setup();
    const server = homeServer();
    const account = h.signIn();
    h.link(account.user.id, server);
    const flow = h.start(server);

    expect((await h.press(account.cookie, flow.query, "http://evil.example")).statusCode).toBe(403);
    const pressed = await h.press(account.cookie, flow.query);
    expect(pressed.statusCode).toBe(200);
    const { redirect } = pressed.json() as { redirect: string };
    expect(redirect.startsWith(`${HOME}/#legato_connect=`)).toBe(true);
    // The same statement mints one code, once.
    expect((await h.press(account.cookie, flow.query)).json()).toMatchObject({ reason: "used" });

    const code = h.codeFrom(redirect);
    // Another page can't spend it, and spending it at all burns it.
    expect((await h.redeem(code, flow.verifier, "http://evil.example")).json()).toMatchObject({ reason: "mismatch" });
    const again = h.start(server);
    const second = h.codeFrom(((await h.press(account.cookie, again.query)).json() as { redirect: string }).redirect);
    const redeemed = await h.redeem(second, again.verifier);
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toMatchObject({ serverId: server.serverId, user: { id: account.user.id, displayName: "Rowan" } });
    expect((await h.redeem(second, again.verifier)).json()).toMatchObject({ reason: "used" });
  });

  it("keeps link codes and connect codes apart", async () => {
    const h = setup();
    const server = homeServer();
    const account = h.signIn();
    h.link(account.user.id, server);
    const verifier = randomBytes(32).toString("base64url");
    const linkRequest = parseLinkRequest({ server: server.serverId, return_to: `${HOME}/`, code_challenge: s256Challenge(verifier) })!;
    const minted = mintLinkCode(h.db, account.user.id, linkRequest, h.keys.linkOriginKeys[0]!);
    if (!minted.ok) throw new Error("mint failed");
    expect((await h.redeem(minted.code, verifier)).json()).toMatchObject({ reason: "not_found" });
  });
});

describe("a web session", () => {
  it("gets relay tickets and access tokens for its own server and nothing else", async () => {
    const h = setup();
    const mine = homeServer();
    const other = homeServer();
    const account = h.signIn();
    h.link(account.user.id, mine);
    h.link(account.user.id, other);
    const { token } = await h.webSession(mine, account);
    const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const post = (url: string, body: unknown) => h.app.inject({ method: "POST", url, headers: bearer, payload: JSON.stringify(body) });

    expect((await post("/auth/relay-ticket", { serverId: mine.serverId })).statusCode).toBe(200);
    expect((await post("/auth/server-token", { serverId: mine.serverId, scope: "access" })).json()).toMatchObject({ scope: "access" });

    for (const [url, body] of [
      ["/auth/relay-ticket", { serverId: other.serverId }],
      ["/auth/server-token", { serverId: other.serverId, scope: "access" }],
      ["/auth/server-token", { serverId: other.serverId }],
    ] as const) {
      const res = await post(url, body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ reason: "wrong_server" });
    }
    // Never a link token, even for its own server: that would ask for a
    // tunnel credential.
    expect((await post("/auth/server-token", { serverId: mine.serverId, scope: "link" })).json()).toMatchObject({ reason: "web_session" });

    // Its servers are its one server; anything account-wide refuses it.
    const listed = await h.app.inject({ method: "GET", url: "/linked-servers", headers: bearer });
    expect((listed.json() as { servers: { serverId: string }[] }).servers.map((s) => s.serverId)).toEqual([mine.serverId]);
    const authorization = { authorization: `Bearer ${token}` };
    expect((await h.app.inject({ method: "DELETE", url: `/linked-servers/${mine.serverId}`, headers: authorization })).statusCode).toBe(
      401,
    );
    expect((await h.app.inject({ method: "GET", url: "/auth/me", headers: bearer })).json()).toMatchObject({ serverId: mine.serverId });

    // And with its ticket, the relay lets it through to its own server only.
    const ticket = ((await post("/auth/relay-ticket", { serverId: mine.serverId })).json() as { ticket: string }).ticket;
    expect(
      (await h.app.inject({ method: "GET", url: `/relay/${other.serverId}/x`, headers: { "x-legato-relay": ticket } })).statusCode,
    ).toBe(401);
    expect(
      (await h.app.inject({ method: "GET", url: `/relay/${mine.serverId}/x`, headers: { authorization: `Bearer ${token}` } })).statusCode,
    ).toBe(401);
    // Not connected, so 503: but past the relay's checks.
    expect(
      (await h.app.inject({ method: "GET", url: `/relay/${mine.serverId}/x`, headers: { "x-legato-relay": ticket } })).statusCode,
    ).toBe(503);
  });

  it("stops getting anything once its server is unlinked", async () => {
    const h = setup();
    const mine = homeServer();
    const account = h.signIn();
    h.link(account.user.id, mine);
    const { token } = await h.webSession(mine, account);
    removeLinkedServer(h.db, account.user.id, mine.serverId);
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/relay-ticket",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ serverId: mine.serverId }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("makes its page one of Legato's own origins, for its server, while it lasts", async () => {
    const h = setup();
    const mine = homeServer();
    const other = homeServer();
    const account = h.signIn();
    h.link(account.user.id, mine);
    const preflight = (url: string, origin: string) =>
      h.app.inject({ method: "OPTIONS", url, headers: { origin, "access-control-request-method": "POST" } });
    const allowed = async (url: string, origin = HOME) => (await preflight(url, origin)).headers["access-control-allow-origin"];

    expect(await allowed("/auth/relay-ticket")).toBeUndefined();
    expect(await allowed(`/relay/${mine.serverId}/api/v1/stats`)).toBeUndefined();

    const { token } = await h.webSession(mine, account);
    expect(await allowed("/auth/relay-ticket")).toBe(HOME);
    expect(await allowed("/linked-servers")).toBe(HOME);
    expect(await allowed(`/relay/${mine.serverId}/api/v1/stats`)).toBe(HOME);
    // Not for another server's relay route, nor another page.
    expect(await allowed(`/relay/${other.serverId}/api/v1/stats`)).toBeUndefined();
    expect(await allowed("/auth/relay-ticket", "http://192.168.1.21:8899")).toBeUndefined();
    // relay.db keeps no address, only its HMAC.
    expect(JSON.stringify(h.db.prepare("SELECT * FROM relay_sessions").all())).not.toContain("192.168.1.20");

    await h.app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(await allowed("/auth/relay-ticket")).toBeUndefined();
    expect(await allowed(`/relay/${mine.serverId}/api/v1/stats`)).toBeUndefined();
  });
});
