import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
// The home server's real signers, as in linked-servers.spec.ts: what a
// server sends is exactly what this relay accepts.
import { claimProof, linkProof, serverIdForPublicKey, unlinkProof, type ServerKey } from "../../server/src/auth/serverKey.js";
import { createSession, upsertUser } from "./accounts.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { claimProofMessage, isLinkedServer, linkProofMessage, unlinkProofMessage, verifyServerSignature } from "./linked-servers.js";
import { OPEN_CODES_PER_ACCOUNT, tunnelCredentialHolder } from "./pairing.js";
import { ASKS_PER_WINDOW, FREE_CODES } from "./rate-limit.js";
import { claimReturnPath } from "./routes/claim-page.js";
import { parseSigningKeys, type SigningKeys } from "./signing-keys.js";

// Issue #237: claiming a headless server from its /setup page. An account
// claims the code the server shows, for the server the QR names (issue
// #324); that server redeems it with a signed proof and gets a `link`
// token; the server's signed link report records the pair and mints the
// tunnel credential, bound to its id.

const ISSUER = "http://relay.test";

function signingKeys(): SigningKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  return parseSigningKeys(JSON.stringify([{ privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) }]))!;
}

function homeServer(): ServerKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
  return { serverId: serverIdForPublicKey(publicKey), publicKey, privateKey };
}

const now = () => Math.floor(Date.now() / 1000);

// The server whose QR the tests' claims come from, unless one says otherwise.
const SERVER = homeServer();

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function setup(options: { signing?: boolean; github?: boolean } = {}) {
  const db = openDb(":memory:");
  const app = buildApp({
    db,
    auth: {
      config: {
        callbackBaseUrl: ISSUER,
        ...(options.github ? { githubClientId: "id", githubClientSecret: "secret" } : {}),
      },
      signingKeys: options.signing === false ? null : signingKeys(),
      exchange: {
        github: async () => ({
          providerUserId: "gh-1",
          email: "rowan@example.com",
          emailVerified: true,
          displayName: "Rowan",
          avatarUrl: null,
        }),
      },
    },
  });
  apps.push(app);

  const signIn = (providerUserId = "g-1") => {
    const user = upsertUser(db, "google", {
      providerUserId,
      email: `${providerUserId}@example.com`,
      emailVerified: true,
      displayName: providerUserId,
      avatarUrl: null,
    });
    return { user, cookie: `relay_session=${createSession(db, user.id).token}` };
  };

  const claim = (cookie: string, code: unknown, server: ServerKey | unknown = SERVER, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/pair/claim",
      headers: { cookie, ...headers },
      payload: { code, server: (server as ServerKey | undefined)?.serverId ?? server },
    });
  const status = async (cookie: string, code: string) =>
    ((await app.inject({ method: "GET", url: `/pair/claim?code=${code}`, headers: { cookie } })).json() as { status: string }).status;
  // From this socket address, or the inject's own loopback one. Off Fly,
  // as here, a Fly-Client-IP header counts for nothing (rate-limit.ts).
  const exchange = (body: Record<string, unknown>, address?: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/pair/exchange", payload: body, headers, ...(address ? { remoteAddress: address } : {}) });
  const exchangeAs = (server: ServerKey, code: string, address?: string) =>
    exchange(claimProof(server, { issuer: ISSUER, code, nowSeconds: now() }), address);
  const report = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/linked-servers", payload: body });
  const credentials = () => db.prepare("SELECT relay_user_id, server_id FROM tunnel_credentials").all();
  const pairs = () => db.prepare("SELECT relay_user_id, server_id FROM linked_servers").all();
  // null: a QR from a server that predates the server id.
  const page = (code: string, cookie?: string, server: string | null = SERVER.serverId) =>
    app.inject({
      method: "GET",
      url: `/claim?code=${code}${server === null ? "" : `&server=${server}`}`,
      headers: cookie ? { cookie } : {},
    });

  return { db, app, signIn, claim, status, exchange, exchangeAs, report, credentials, pairs, page };
}

describe("a claim, start to finish", () => {
  it("records the pair and mints one credential, bound to the server's id, when the server reports the link", async () => {
    const h = setup();
    const { user, cookie } = h.signIn();
    const server = homeServer();

    const claimed = await h.claim(cookie, "k7qm 4xrd", server);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ claimed: { code: "K7QM-4XRD" }, already: false });
    expect(await h.status(cookie, "K7QM-4XRD")).toBe("pending");

    const exchanged = await h.exchangeAs(server, "K7QM-4XRD");
    expect(exchanged.statusCode).toBe(200);
    const { linkToken } = exchanged.json() as { linkToken: string };
    expect(await h.status(cookie, "K7QM-4XRD")).toBe("picked_up");
    // Picked up, not yet linked: nothing to show for it on legato.fm yet.
    expect(h.pairs()).toEqual([]);
    expect(h.credentials()).toEqual([]);

    const reported = await h.report(linkProof(server, linkToken));
    expect(reported.statusCode).toBe(200);
    const body = reported.json() as { linked: unknown; tunnel: { credential: string; expiresAt: string } };
    expect(body.linked).toEqual({ accountId: String(user.id), serverId: server.serverId });
    expect(body.tunnel.credential).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(body.tunnel.expiresAt).getTime()).toBeGreaterThan(Date.now() + 300 * 24 * 3600 * 1000);
    expect(h.pairs()).toEqual([{ relay_user_id: user.id, server_id: server.serverId }]);
    expect(h.credentials()).toEqual([{ relay_user_id: user.id, server_id: server.serverId }]);
    expect(tunnelCredentialHolder(h.db, body.tunnel.credential)).toEqual({ relayUserId: user.id, serverId: server.serverId });

    // The same report again is a spent proof, and mints nothing more.
    expect((await h.report(linkProof(server, linkToken))).json()).toMatchObject({ reason: "used" });
    expect(h.credentials()).toHaveLength(1);
  });

  it("leaves no credential and no pair when the server never reports the link", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD");
    expect((await h.exchangeAs(SERVER, "K7QM-4XRD")).statusCode).toBe(200);

    // Declined at /setup, lapsed, or forgotten in a restart: the server
    // just doesn't report. All three look like this from here.
    expect(h.credentials()).toEqual([]);
    expect(h.pairs()).toEqual([]);
  });

  // Issue #325: a server linked from Settings, with no claim, needs a
  // tunnel as much as a claimed one, so its link mints one the same way.
  it("mints a credential for an ordinary link too, once it's reported", async () => {
    const h = setup();
    const { user, cookie } = h.signIn();
    const server = homeServer();
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/server-token",
      headers: { cookie },
      payload: { serverId: server.serverId, scope: "link" },
    });
    expect(h.credentials()).toEqual([]);
    const reported = await h.report(linkProof(server, (res.json() as { token: string }).token));
    expect(reported.json()).toMatchObject({ linked: { accountId: String(user.id), serverId: server.serverId } });
    expect(h.credentials()).toEqual([{ relay_user_id: user.id, server_id: server.serverId }]);
  });
});

describe("the exchange proof", () => {
  it("answers any server but the one the claim is for as if nobody had claimed the code, and doesn't spend it", async () => {
    const h = setup();
    const { user, cookie } = h.signIn();
    const real = homeServer();
    await h.claim(cookie, "K7QM-4XRD", real);

    // Something that guessed the code, or read it off the screen, with a
    // key of its own: the same answer as for a code nobody claimed.
    const nobodys = await h.exchangeAs(homeServer(), "AAAA-BBBB");
    for (const hostile of [homeServer(), homeServer()]) {
      const res = await h.exchangeAs(hostile, "K7QM-4XRD");
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(nobodys.json());
    }
    expect(await h.status(cookie, "K7QM-4XRD")).toBe("pending");

    // The server the QR named still picks it up, for its own id.
    const picked = await h.exchangeAs(real, "K7QM-4XRD");
    expect(picked.statusCode).toBe(200);
    const { linkToken } = picked.json() as { linkToken: string };
    const claims = JSON.parse(Buffer.from(linkToken.split(".")[1]!, "base64url").toString()) as { sub: string; aud: string };
    expect(claims).toMatchObject({ sub: String(user.id), aud: real.serverId });
    // And once it's spent, other servers still hear nothing about it.
    expect((await h.exchangeAs(homeServer(), "K7QM-4XRD")).json()).toEqual(nobodys.json());
  });

  // POST /pair/start minted codes like that until #353, and claims made
  // before #324 are the same.
  it("lets no server redeem a code that isn't bound to one", async () => {
    const h = setup();
    const { user } = h.signIn();
    h.db
      .prepare("INSERT INTO pairing_codes (code, relay_user_id, expires_at) VALUES ('NSRV-0000', ?, datetime('now', '+5 minutes'))")
      .run(user.id);
    const nobodys = await h.exchangeAs(homeServer(), "AAAA-BBBB");
    for (const server of [SERVER, homeServer(), homeServer()]) {
      const res = await h.exchangeAs(server, "NSRV-0000");
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(nobodys.json());
    }
    expect(h.db.prepare("SELECT server_id, used_at FROM pairing_codes WHERE code = 'NSRV-0000'").get()).toEqual({
      server_id: null,
      used_at: null,
    });
  });

  it("is gone with POST /pair/start: no route mints a code nobody's server showed", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    expect((await h.app.inject({ method: "POST", url: "/pair/start", headers: { cookie } })).statusCode).toBe(404);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM pairing_codes").get()).toEqual({ n: 0 });
  });

  it("refuses a signature by another key, over another code, or for another service", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const server = homeServer();
    const other = homeServer();
    await h.claim(cookie, "K7QM-4XRD", server);

    const borrowed = { ...claimProof(other, { issuer: ISSUER, code: "K7QM-4XRD", nowSeconds: now() }), publicKey: server.publicKey };
    expect((await h.exchange(borrowed)).json()).toMatchObject({ reason: "bad_signature" });
    const otherCode = { ...claimProof(server, { issuer: ISSUER, code: "AAAA-BBBB", nowSeconds: now() }), code: "K7QM-4XRD" };
    expect((await h.exchange(otherCode)).json()).toMatchObject({ reason: "bad_signature" });
    const elsewhere = claimProof(server, { issuer: "https://auth.legato.fm", code: "K7QM-4XRD", nowSeconds: now() });
    expect((await h.exchange(elsewhere)).json()).toMatchObject({ reason: "bad_signature" });
    // None of those spent the code.
    expect((await h.exchangeAs(server, "K7QM-4XRD")).statusCode).toBe(200);
  });

  it("refuses a stale proof", async () => {
    const h = setup();
    const res = await h.exchange(claimProof(homeServer(), { issuer: ISSUER, code: "K7QM-4XRD", nowSeconds: now() - 600 }));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ reason: "stale" });
  });

  it("can't be read as a link or unlink proof, or the other way round", () => {
    const server = homeServer();
    const claimMessage = claimProofMessage({ issuer: ISSUER, serverId: server.serverId, code: "K7QM-4XRD", issuedAt: 1 });
    const claimSignature = claimProof(server, { issuer: ISSUER, code: "K7QM-4XRD", nowSeconds: 1 }).signature;
    expect(verifyServerSignature(server.publicKey, claimMessage, claimSignature)).toBe(true);

    // The same fields under the other prefixes.
    expect(verifyServerSignature(server.publicKey, linkProofMessage(claimMessage.split("\n").slice(1).join("\n")), claimSignature)).toBe(
      false,
    );
    const unlinkMessage = unlinkProofMessage({
      issuer: ISSUER,
      serverId: server.serverId,
      accountId: "1",
      issuedAt: 1,
      nonce: "K7QM-4XRD",
    });
    expect(verifyServerSignature(server.publicKey, unlinkMessage, claimSignature)).toBe(false);

    const link = linkProof(server, "a.b.c");
    expect(verifyServerSignature(server.publicKey, claimMessage, link.signature)).toBe(false);
    const unlink = unlinkProof(server, { issuer: ISSUER, accountId: "1", nowSeconds: 1 });
    expect(verifyServerSignature(server.publicKey, claimMessage, unlink.signature)).toBe(false);
    // And a raw signature over the bare code isn't a claim proof either.
    const raw = sign(null, Buffer.from("K7QM-4XRD"), server.privateKey).toString("base64url");
    expect(verifyServerSignature(server.publicKey, claimMessage, raw)).toBe(false);
  });
});

describe("POST /pair/claim", () => {
  it("needs a session", async () => {
    const h = setup();
    expect((await h.claim("", "K7QM-4XRD")).statusCode).toBe(401);
  });

  it("is the same claim when the same account claims again, for whichever server it names last", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD");
    const again = await h.claim(cookie, "K7QM-4XRD");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ already: true });

    const other = homeServer();
    expect((await h.claim(cookie, "K7QM-4XRD", other)).json()).toMatchObject({ already: true });
    expect((await h.exchangeAs(SERVER, "K7QM-4XRD")).statusCode).toBe(404);
    expect((await h.exchangeAs(other, "K7QM-4XRD")).statusCode).toBe(200);
  });

  it("asks for the server to be updated when the claim doesn't say which server, and stores nothing", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const unnamed = await h.app.inject({ method: "POST", url: "/pair/claim", headers: { cookie }, payload: { code: "K7QM-4XRD" } });
    for (const res of [
      unnamed,
      ...(await Promise.all(
        [null, "", "not-a-server-id", 42, SERVER.serverId.toUpperCase()].map((id) => h.claim(cookie, "K7QM-4XRD", id)),
      )),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ reason: "outdated_server" });
    }
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM pairing_codes").get()).toEqual({ n: 0 });
  });

  it("refuses a second account, without touching the first one's claim", async () => {
    const h = setup();
    const first = h.signIn("first");
    const second = h.signIn("second");
    await h.claim(first.cookie, "K7QM-4XRD");

    const res = await h.claim(second.cookie, "K7QM-4XRD");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "taken" });
    expect(await h.status(second.cookie, "K7QM-4XRD")).toBe("taken");
    expect(await h.status(first.cookie, "K7QM-4XRD")).toBe("pending");

    const { linkToken } = (await h.exchangeAs(SERVER, "K7QM-4XRD")).json() as { linkToken: string };
    const claims = JSON.parse(Buffer.from(linkToken.split(".")[1]!, "base64url").toString()) as { sub: string };
    expect(claims.sub).toBe(String(first.user.id));
  });

  it("says a spent code is used, and takes over an expired one nobody spent", async () => {
    const h = setup();
    const old = h.signIn("old");
    const { user, cookie } = h.signIn("new");
    h.db
      .prepare(
        "INSERT INTO pairing_codes (code, relay_user_id, expires_at, used_at) VALUES ('SPNT-0000', ?, datetime('now', '-1 hour'), datetime('now', '-2 hours'))",
      )
      .run(old.user.id);
    h.db
      .prepare("INSERT INTO pairing_codes (code, relay_user_id, expires_at) VALUES ('EXPD-0000', ?, datetime('now', '-1 minute'))")
      .run(old.user.id);

    expect((await h.claim(cookie, "SPNT-0000")).statusCode).toBe(410);
    expect(await h.status(cookie, "SPNT-0000")).toBe("used");
    expect((await h.claim(cookie, "EXPD-0000")).statusCode).toBe(200);
    expect(h.db.prepare("SELECT relay_user_id FROM pairing_codes WHERE code = 'EXPD-0000'").get()).toEqual({ relay_user_id: user.id });
  });

  it("refuses something that isn't a code", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    for (const code of ["", "K7QM", "K7QM-4XRD-0", 42, null]) {
      expect((await h.claim(cookie, code)).json()).toMatchObject({ reason: "bad_code" });
    }
  });

  it(`holds an account to ${OPEN_CODES_PER_ACCOUNT} open codes at once`, async () => {
    const h = setup();
    const { cookie } = h.signIn();
    for (let i = 0; i < OPEN_CODES_PER_ACCOUNT; i++) expect((await h.claim(cookie, `AAAA-000${i}`)).statusCode).toBe(200);
    const res = await h.claim(cookie, "AAAA-0009");
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ reason: "too_many" });
  });

  it("refuses a page on another origin", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    expect((await h.claim(cookie, "K7QM-4XRD", SERVER, { origin: "https://legato.fm" })).json()).toMatchObject({ reason: "cross_origin" });
    expect((await h.claim(cookie, "K7QM-4XRD", SERVER, { origin: ISSUER })).statusCode).toBe(200);
  });

  it("won't take a code while this relay can't sign tokens", async () => {
    const h = setup({ signing: false });
    const { cookie } = h.signIn();
    expect((await h.claim(cookie, "K7QM-4XRD")).statusCode).toBe(503);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM pairing_codes").get()).toEqual({ n: 0 });
  });
});

describe("guessing codes at POST /pair/exchange", () => {
  const GUESSER = "203.0.113.9";
  // Codes nobody claimed, in the setup code's own format.
  const guess = (i: number) => `AAAA-${String(i).padStart(4, "0")}`;

  it("locks out one address asking about too many codes nobody claimed, with Retry-After", async () => {
    const h = setup();
    const guesser = homeServer();
    for (let i = 0; i <= FREE_CODES; i++) expect((await h.exchangeAs(guesser, guess(i), GUESSER)).statusCode).toBe(404);
    // A fresh key buys nothing: it's the address that's locked out.
    const limited = await h.exchangeAs(homeServer(), guess(FREE_CODES + 1), GUESSER);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({ reason: "rate_limited" });

    // Someone else's server picks up its claim as usual.
    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD");
    expect((await h.exchangeAs(SERVER, "K7QM-4XRD", "198.51.100.4")).statusCode).toBe(200);
  });

  it("counts a code claimed for another server as one nobody claimed", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD");
    const guesser = homeServer();
    expect((await h.exchangeAs(guesser, "K7QM-4XRD", GUESSER)).statusCode).toBe(404);
    for (let i = 1; i <= FREE_CODES; i++) expect((await h.exchangeAs(guesser, guess(i), GUESSER)).statusCode).toBe(404);
    expect((await h.exchangeAs(guesser, guess(FREE_CODES + 1), GUESSER)).statusCode).toBe(429);
  });

  // A 404 says the same whoever signed the proof, so the relay doesn't
  // check: a code nobody claimed for this server costs a lookup, not a
  // signature check. A code claimed for it is always checked.
  it("answers a code nobody claimed for the server asking without checking the signature", async () => {
    const h = setup();
    const guesser = homeServer();
    const forged = (code: string, server = guesser) => ({
      ...claimProof(server, { issuer: ISSUER, code, nowSeconds: now() }),
      signature: "x",
    });
    expect((await h.exchange(forged("AAAA-BBBB"), "198.51.100.4")).json()).toMatchObject({ reason: "not_found" });
    for (let i = 0; i <= FREE_CODES; i++) await h.exchange(forged(guess(i)), GUESSER);
    expect((await h.exchange(forged(guess(FREE_CODES + 1)), GUESSER)).statusCode).toBe(429);

    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD");
    const res = await h.exchange(forged("K7QM-4XRD", SERVER), GUESSER);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "bad_signature" });
  });

  // Issue #324, review: the limiter used to run before the lookup, so this
  // claim got a 429 until it expired.
  it("answers a claim from an address that's locked out, for a code that address never asked about", async () => {
    const h = setup();
    const server = homeServer();
    expect((await h.exchangeAs(server, "AAAA-AAAA", GUESSER)).statusCode).toBe(404);
    // Something else behind the same NAT or /64 asks about too many codes.
    const guesser = homeServer();
    for (let i = 0; i <= FREE_CODES; i++) await h.exchangeAs(guesser, guess(i), GUESSER);

    // The server's code changes during the lockout. The new one is new to
    // the relay, so asking about it waits.
    expect((await h.exchangeAs(server, "K7QM-4XRD", GUESSER)).statusCode).toBe(429);
    // Until someone claims it for this server.
    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD", server);
    expect((await h.exchangeAs(server, "K7QM-4XRD", GUESSER)).statusCode).toBe(200);
  });

  it(`answers a claim from an address past its ${ASKS_PER_WINDOW} asks a minute`, async () => {
    const h = setup();
    const server = homeServer();
    const looper = homeServer();
    for (let i = 0; i < ASKS_PER_WINDOW; i++) await h.exchangeAs(looper, guess(i % 3), GUESSER);
    expect((await h.exchangeAs(looper, guess(0), GUESSER)).statusCode).toBe(429);
    expect((await h.exchangeAs(server, "K7QM-4XRD", GUESSER)).statusCode).toBe(429);

    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD", server);
    expect((await h.exchangeAs(server, "K7QM-4XRD", GUESSER)).statusCode).toBe(200);
  });

  it("takes no notice of a Fly-Client-IP header off Fly", async () => {
    const h = setup();
    const guesser = homeServer();
    for (let i = 0; i <= FREE_CODES; i++) {
      await h.exchange(claimProof(guesser, { issuer: ISSUER, code: guess(i), nowSeconds: now() }), GUESSER, {
        "fly-client-ip": `198.51.100.${i}`,
      });
    }
    const next = claimProof(guesser, { issuer: ISSUER, code: guess(FREE_CODES + 1), nowSeconds: now() });
    expect((await h.exchange(next, GUESSER, { "fly-client-ip": "198.51.100.200" })).statusCode).toBe(429);
  });

  it("never locks out a server asking about its own code until it's claimed", async () => {
    const h = setup();
    const server = homeServer();
    for (let i = 0; i < 3 * FREE_CODES; i++) expect((await h.exchangeAs(server, "K7QM-4XRD", GUESSER)).statusCode).toBe(404);
    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD", server);
    expect((await h.exchangeAs(server, "K7QM-4XRD", GUESSER)).statusCode).toBe(200);
  });

  it("still answers a server about its own code behind an address that's locked out", async () => {
    const h = setup();
    const server = homeServer();
    expect((await h.exchangeAs(server, "K7QM-4XRD", GUESSER)).statusCode).toBe(404);
    const guesser = homeServer();
    for (let i = 0; i <= FREE_CODES; i++) await h.exchangeAs(guesser, guess(i), GUESSER);
    expect((await h.exchangeAs(guesser, guess(FREE_CODES + 1), GUESSER)).statusCode).toBe(429);

    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD", server);
    expect((await h.exchangeAs(server, "K7QM-4XRD", GUESSER)).statusCode).toBe(200);
  });

  it("counts only codes nobody knows: not spent ones, and not bad proofs", async () => {
    const h = setup();
    const { user } = h.signIn();
    const server = homeServer();
    for (let i = 0; i <= FREE_CODES; i++) {
      const code = `SPNT-${String(i).padStart(4, "0")}`;
      h.db
        .prepare(
          "INSERT INTO pairing_codes (code, relay_user_id, server_id, expires_at, used_at) VALUES (?, ?, ?, datetime('now', '+5 minutes'), datetime('now'))",
        )
        .run(code, user.id, server.serverId);
      expect((await h.exchangeAs(server, code, GUESSER)).statusCode).toBe(410);
      const stale = claimProof(server, { issuer: ISSUER, code: guess(i), nowSeconds: now() - 600 });
      expect((await h.exchange(stale, GUESSER)).statusCode).toBe(401);
    }
    expect((await h.exchangeAs(server, guess(0), GUESSER)).statusCode).toBe(404);
  });
});

describe("GET /pair/claim", () => {
  it("says a claim expired when the server never picked it up", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD");
    h.db.prepare("UPDATE pairing_codes SET expires_at = datetime('now', '-1 minute')").run();
    expect(await h.status(cookie, "K7QM-4XRD")).toBe("expired");
    expect(await h.status(cookie, "AAAA-BBBB")).toBe("none");
  });
});

describe("the claim page", () => {
  const view = (html: string) => /<body data-view="([a-z_]+)"/.exec(html)?.[1];

  it("asks a signed-out visitor to sign in, and comes back to the same code and server", async () => {
    const h = setup({ github: true });
    const back = `/claim?code=K7QM-4XRD&server=${SERVER.serverId}`;
    const res = await h.page("k7qm4xrd");
    expect(res.statusCode).toBe(200);
    expect(view(res.body)).toBe("signed_out");
    expect(res.body).toContain("K7QM-4XRD");
    expect(res.body).toContain(`href="/auth/github?return_to=${encodeURIComponent(back)}"`);
    expect(res.body).not.toContain("/auth/google?");

    const start = await h.app.inject({ method: "GET", url: `/auth/github?return_to=${encodeURIComponent(back)}` });
    const cookies = start.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const callback = await h.app.inject({
      method: "GET",
      url: `/auth/github/callback?code=x&state=${state}`,
      headers: { cookie: cookies },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(back);
    expect(callback.cookies.find((c) => c.name === "relay_session")?.value).toBeTruthy();
  });

  it("only ever goes back to the claim page", () => {
    const id = SERVER.serverId;
    expect(claimReturnPath(`/claim?code=k7qm4xrd&server=${id}`)).toBe(`/claim?code=K7QM-4XRD&server=${id}`);
    for (const bad of [
      `//evil.example/claim?code=K7QM-4XRD&server=${id}`,
      `https://evil.example/claim?code=K7QM-4XRD&server=${id}`,
      `/claimx?code=K7QM-4XRD&server=${id}`,
      `/claim?code=nope&server=${id}`,
      "/claim?code=K7QM-4XRD",
      "/claim?code=K7QM-4XRD&server=%22%3E%3Cscript%3E",
      "/auth/me",
      undefined,
    ]) {
      expect(claimReturnPath(bad)).toBeNull();
    }
  });

  it("shows each state of the account's claim", async () => {
    const h = setup();
    const mine = h.signIn("mine");
    const theirs = h.signIn("theirs");

    expect(view((await h.page("K7QM-4XRD", mine.cookie)).body)).toBe("ready");
    await h.claim(mine.cookie, "K7QM-4XRD");
    expect(view((await h.page("K7QM-4XRD", mine.cookie)).body)).toBe("pending");
    expect(view((await h.page("K7QM-4XRD", theirs.cookie)).body)).toBe("taken");
    await h.exchangeAs(SERVER, "K7QM-4XRD");
    expect(view((await h.page("K7QM-4XRD", mine.cookie)).body)).toBe("picked_up");
    expect(view((await h.page("K7QM-4XRD", theirs.cookie)).body)).toBe("used");

    await h.claim(mine.cookie, "AAAA-BBBB");
    h.db.prepare("UPDATE pairing_codes SET expires_at = datetime('now', '-1 minute') WHERE code = 'AAAA-BBBB'").run();
    expect(view((await h.page("AAAA-BBBB", mine.cookie)).body)).toBe("expired");
  });

  it("says when the code can't be one, and when claiming isn't available", async () => {
    expect(view((await setup().page("hello")).body)).toBe("bad_code");
    expect(view((await setup().page("K7QM-4XRD", undefined, "not-a-server-id")).body)).toBe("bad_code");
    const off = await setup({ signing: false }).page("K7QM-4XRD");
    expect(off.statusCode).toBe(503);
    expect(view(off.body)).toBe("unavailable");
  });

  it("asks to update a server whose QR doesn't say which server it is, before anything else", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    for (const res of [await h.page("K7QM-4XRD", undefined, null), await h.page("K7QM-4XRD", cookie, null)]) {
      expect(res.statusCode).toBe(400);
      expect(view(res.body)).toBe("outdated_server");
      expect(res.body).toContain("Update Legato on the server");
      expect(res.body).not.toContain("<button");
    }
  });

  it("sends a policy that runs only its own script and style, and talks only to this service", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const pages = [
      await h.page("K7QM-4XRD"),
      await h.page("K7QM-4XRD", cookie),
      await h.page("hello"),
      await h.page("K7QM-4XRD", cookie, null),
      await setup({ signing: false }).page("K7QM-4XRD"),
    ];
    expect(pages.map((res) => res.statusCode)).toEqual([200, 200, 400, 400, 503]);
    for (const res of pages) {
      const policy = res.headers["content-security-policy"] as string;
      const directives = new Map(
        policy
          .split(";")
          .map((d) => d.trim().split(/\s+/))
          .map(([name, ...sources]) => [name, sources]),
      );
      const hashOf = (tag: string) => {
        const inline = res.body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")) ?? [];
        expect(inline).toHaveLength(1);
        const text = inline[0]!.slice(tag.length + 2, -(tag.length + 3));
        return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
      };
      expect(directives.get("default-src")).toEqual(["'none'"]);
      expect(directives.get("script-src")).toEqual([hashOf("script")]);
      expect(directives.get("style-src")).toEqual([hashOf("style")]);
      expect(directives.get("connect-src")).toEqual(["'self'"]);
      expect(policy).not.toContain("unsafe");
      // Nothing inline the hashes don't cover.
      expect(res.body).not.toMatch(/\s(on[a-z]+|style)=/);
    }
    // The script reads the code and server off the page rather than having
    // them written in.
    expect(pages[1]!.body).toContain(`<body data-view="ready" data-code="K7QM-4XRD" data-server="${SERVER.serverId}">`);
  });

  it("escapes the account's name", async () => {
    const h = setup();
    const { cookie } = h.signIn('<img src=x onerror="alert(1)">');
    const res = await h.page("K7QM-4XRD", cookie);
    expect(res.body).not.toContain("<img src=x");
    expect(res.body).toContain("&lt;img src=x");
  });
});

describe("an account deleted mid-claim", () => {
  it("takes its claims with it", async () => {
    const h = setup();
    const { user, cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD");
    h.db.prepare("DELETE FROM relay_users WHERE id = ?").run(user.id);
    expect((await h.exchangeAs(SERVER, "K7QM-4XRD")).statusCode).toBe(404);
    expect(isLinkedServer(h.db, user.id, SERVER.serverId)).toBe(false);
  });
});
