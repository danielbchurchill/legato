import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
// The home server's real signers, as in linked-servers.spec.ts: what a
// server sends is exactly what this relay accepts.
import { claimProof, linkProof, serverIdForPublicKey, unlinkProof, type ServerKey } from "../../server/src/auth/serverKey.js";
import { createSession, upsertUser } from "./accounts.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { claimProofMessage, isLinkedServer, linkProofMessage, unlinkProofMessage, verifyServerSignature } from "./linked-servers.js";
import { mintPairingCode, OPEN_CODES_PER_ACCOUNT, tunnelCredentialHolder } from "./pairing.js";
import { claimReturnPath } from "./routes/claim-page.js";
import { parseSigningKeys, type SigningKeys } from "./signing-keys.js";

// Issue #237: claiming a headless server from its /setup page. An account
// claims the code the server shows; the server redeems it with a signed
// proof and gets a `link` token; the server's signed link report records
// the pair and mints the tunnel credential, bound to its id.

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

  const claim = (cookie: string, code: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/pair/claim", headers: { cookie, ...headers }, payload: { code } });
  const status = async (cookie: string, code: string) =>
    ((await app.inject({ method: "GET", url: `/pair/claim?code=${code}`, headers: { cookie } })).json() as { status: string }).status;
  const exchange = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/pair/exchange", payload: body });
  const exchangeAs = (server: ServerKey, code: string) => exchange(claimProof(server, { issuer: ISSUER, code, nowSeconds: now() }));
  const report = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/linked-servers", payload: body });
  const credentials = () => db.prepare("SELECT relay_user_id, server_id FROM tunnel_credentials").all();
  const pairs = () => db.prepare("SELECT relay_user_id, server_id FROM linked_servers").all();
  const page = (code: string, cookie?: string) =>
    app.inject({ method: "GET", url: `/claim?code=${code}`, headers: cookie ? { cookie } : {} });

  return { db, app, signIn, claim, status, exchange, exchangeAs, report, credentials, pairs, page };
}

describe("a claim, start to finish", () => {
  it("records the pair and mints one credential, bound to the server's id, when the server reports the link", async () => {
    const h = setup();
    const { user, cookie } = h.signIn();
    const server = homeServer();

    const claimed = await h.claim(cookie, "k7qm 4xrd");
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
    expect((await h.exchangeAs(homeServer(), "K7QM-4XRD")).statusCode).toBe(200);

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
  it("binds what's redeemed to the key that redeemed it, so a different server can't use the link token", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const real = homeServer();
    const hostile = homeServer();
    await h.claim(cookie, "K7QM-4XRD");

    // Something else that read the code off the screen redeems it first,
    // with its own key. What it gets is a token for its own id.
    const stolen = await h.exchangeAs(hostile, "K7QM-4XRD");
    const { linkToken } = stolen.json() as { linkToken: string };
    // The real server can't report that token as its own...
    expect((await h.report(linkProof(real, linkToken))).json()).toMatchObject({ reason: "wrong_key" });
    // ...and its own exchange says the code was already used.
    expect((await h.exchangeAs(real, "K7QM-4XRD")).json()).toMatchObject({ reason: "used" });
    expect(h.pairs().map((pair) => (pair as { server_id: string }).server_id)).not.toContain(real.serverId);
  });

  it("refuses a signature by another key, over another code, or for another service", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD");
    const server = homeServer();
    const other = homeServer();

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

  it("is the same claim when the same account claims again", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    await h.claim(cookie, "K7QM-4XRD");
    const again = await h.claim(cookie, "K7QM-4XRD");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ already: true });
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

    const { linkToken } = (await h.exchangeAs(homeServer(), "K7QM-4XRD")).json() as { linkToken: string };
    const claims = JSON.parse(Buffer.from(linkToken.split(".")[1]!, "base64url").toString()) as { sub: string };
    expect(claims.sub).toBe(String(first.user.id));
  });

  it("refuses a code that clashes with another account's live pairing code, and never overwrites it", async () => {
    const h = setup();
    const minter = h.signIn("minter");
    const claimer = h.signIn("claimer");
    const { code } = mintPairingCode(h.db, minter.user.id, () => "K7QM-4XRD");
    expect(code).toBe("K7QM-4XRD");

    expect((await h.claim(claimer.cookie, code)).json()).toMatchObject({ reason: "taken" });
    expect(h.db.prepare("SELECT relay_user_id FROM pairing_codes WHERE code = ?").get(code)).toEqual({ relay_user_id: minter.user.id });
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
    expect((await h.claim(cookie, "K7QM-4XRD", { origin: "https://legato.fm" })).json()).toMatchObject({ reason: "cross_origin" });
    expect((await h.claim(cookie, "K7QM-4XRD", { origin: ISSUER })).statusCode).toBe(200);
  });

  it("won't take a code while this relay can't sign tokens", async () => {
    const h = setup({ signing: false });
    const { cookie } = h.signIn();
    expect((await h.claim(cookie, "K7QM-4XRD")).statusCode).toBe(503);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM pairing_codes").get()).toEqual({ n: 0 });
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

  it("asks a signed-out visitor to sign in, and comes back to the same code", async () => {
    const h = setup({ github: true });
    const res = await h.page("k7qm4xrd");
    expect(res.statusCode).toBe(200);
    expect(view(res.body)).toBe("signed_out");
    expect(res.body).toContain("K7QM-4XRD");
    expect(res.body).toContain(`href="/auth/github?return_to=${encodeURIComponent("/claim?code=K7QM-4XRD")}"`);
    expect(res.body).not.toContain("/auth/google?");

    const start = await h.app.inject({ method: "GET", url: `/auth/github?return_to=${encodeURIComponent("/claim?code=K7QM-4XRD")}` });
    const cookies = start.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const callback = await h.app.inject({
      method: "GET",
      url: `/auth/github/callback?code=x&state=${state}`,
      headers: { cookie: cookies },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/claim?code=K7QM-4XRD");
    expect(callback.cookies.find((c) => c.name === "relay_session")?.value).toBeTruthy();
  });

  it("only ever goes back to the claim page", () => {
    expect(claimReturnPath("/claim?code=k7qm4xrd")).toBe("/claim?code=K7QM-4XRD");
    for (const bad of [
      "//evil.example/claim?code=K7QM-4XRD",
      "https://evil.example/claim?code=K7QM-4XRD",
      "/claimx?code=K7QM-4XRD",
      "/claim?code=nope",
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
    await h.exchangeAs(homeServer(), "K7QM-4XRD");
    expect(view((await h.page("K7QM-4XRD", mine.cookie)).body)).toBe("picked_up");
    expect(view((await h.page("K7QM-4XRD", theirs.cookie)).body)).toBe("used");

    await h.claim(mine.cookie, "AAAA-BBBB");
    h.db.prepare("UPDATE pairing_codes SET expires_at = datetime('now', '-1 minute') WHERE code = 'AAAA-BBBB'").run();
    expect(view((await h.page("AAAA-BBBB", mine.cookie)).body)).toBe("expired");
  });

  it("says when the code can't be one, and when claiming isn't available", async () => {
    expect(view((await setup().page("hello")).body)).toBe("bad_code");
    const off = await setup({ signing: false }).page("K7QM-4XRD");
    expect(off.statusCode).toBe(503);
    expect(view(off.body)).toBe("unavailable");
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
    expect((await h.exchangeAs(homeServer(), "K7QM-4XRD")).statusCode).toBe(404);
    expect(isLinkedServer(h.db, user.id, homeServer().serverId)).toBe(false);
  });
});
