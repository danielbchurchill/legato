import { createHmac, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
// The home server's real proof signer and token verifier, not copies: what
// the web client hands its server has to be exactly what that server
// accepts, and its report exactly what this relay accepts.
import { linkProof, serverIdForPublicKey, type ServerKey } from "../../server/src/auth/serverKey.js";
import { importEd25519Jwk, verifyLegatoToken } from "../../server/src/auth/legatoToken.js";
import { createSession, upsertUser } from "./accounts.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { mintLinkCode, OPEN_LINK_CODES_PER_ACCOUNT, parseLinkRequest, parseReturnTo, redeemLinkCode } from "./link-codes.js";
import { s256Challenge, sha256Hex } from "./native-sign-in.js";
import { tunnelCredentialHolder } from "./pairing.js";
import { linkReturnPath } from "./routes/link-page.js";
import { parseSigningKeys, type SigningKeys } from "./signing-keys.js";

// Issue #325: a home server's web client links its server through this
// page, with PKCE, and comes back with a one-time code in the fragment.

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

function setup(options: { signing?: boolean } = {}) {
  const db = openDb(":memory:");
  const keys = signingKeys();
  const app = buildApp({
    db,
    auth: {
      config: { callbackBaseUrl: ISSUER, githubClientId: "id", githubClientSecret: "secret" },
      signingKeys: options.signing === false ? null : keys,
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

  // What the web client does before it leaves: a verifier it keeps, and the
  // query it sends.
  const start = (serverId: string, returnTo = `${HOME}/`) => {
    const verifier = randomBytes(32).toString("base64url");
    const query = { server: serverId, return_to: returnTo, code_challenge: s256Challenge(verifier) };
    return { verifier, query, url: `/link?${new URLSearchParams(query)}` };
  };
  const page = (url: string, cookie?: string) => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
  const press = (cookie: string, body: Record<string, unknown>, origin: string = ISSUER) =>
    app.inject({ method: "POST", url: "/link", headers: { cookie, origin }, payload: body });
  // null sends no Origin header at all. address is the socket's peer: off
  // Fly, as here, the only address rate-limit.ts's clientAddress reads.
  const redeem = (code: string, verifier: string, origin: string | null = HOME, address?: string) =>
    app.inject({
      method: "POST",
      url: "/link/redeem",
      headers: origin ? { origin } : {},
      payload: { code, code_verifier: verifier },
      ...(address ? { remoteAddress: address } : {}),
    });
  const report = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/linked-servers", payload: body });
  const credentials = () => db.prepare("SELECT relay_user_id, server_id FROM tunnel_credentials").all();
  const pairs = () => db.prepare("SELECT relay_user_id, server_id FROM linked_servers").all();

  return { db, app, keys, signIn, start, page, press, redeem, report, credentials, pairs };
}

const view = (body: string) => body.match(/<body data-view="([a-z_]+)"/)?.[1];

function codeFrom(redirect: string): string {
  const url = new URL(redirect);
  return new URLSearchParams(url.hash.slice(1)).get("legato_link")!;
}

describe("linking from a web client, start to finish", () => {
  it("signs in, sends a code back, swaps it for a link token, and mints the credential only when the server reports", async () => {
    const h = setup();
    const server = homeServer();
    const { verifier, query, url } = h.start(server.serverId, `${HOME}/?panel=settings#old`);

    // Signed out: the host it would go back to, and a sign-in that returns here.
    const signedOut = await h.page(url);
    expect(signedOut.statusCode).toBe(200);
    expect(view(signedOut.body)).toBe("signed_out");
    expect(signedOut.body).toContain('<p class="address" aria-label="server address">http://192.168.1.20:8899</p>');
    const back = `/link?${new URLSearchParams({ ...query, return_to: `${HOME}/` })}`;
    expect(signedOut.body).toContain(`href="/auth/github?return_to=${encodeURIComponent(back)}"`);

    const begin = await h.app.inject({ method: "GET", url: `/auth/github?return_to=${encodeURIComponent(url)}` });
    const state = new URL(begin.headers.location as string).searchParams.get("state");
    const cookies = begin.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const callback = await h.app.inject({ method: "GET", url: `/auth/github/callback?code=x&state=${state}`, headers: { cookie: cookies } });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(back);
    const session = `relay_session=${callback.cookies.find((c) => c.name === "relay_session")!.value}`;

    // Signed in: the question, and nothing has gone anywhere yet.
    const ready = await h.page(back, session);
    expect(view(ready.body)).toBe("ready");
    expect(ready.body).toContain("Link the Legato server at this address to Rowan (rowan@example.com)?");
    expect(ready.headers.location).toBeUndefined();
    // Cancel goes back saying so, with no code.
    expect(ready.body).toContain(`"cancel":"${HOME}/#legato_link=cancelled"`);

    const pressed = await h.press(session, query);
    expect(pressed.statusCode).toBe(200);
    const { redirect } = pressed.json() as { redirect: string };
    // Origin and path only, the code in the fragment, nothing else.
    expect(redirect.startsWith(`${HOME}/#legato_link=`)).toBe(true);
    const code = codeFrom(redirect);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.pairs()).toEqual([]);
    expect(h.credentials()).toEqual([]);

    const redeemed = await h.redeem(code, verifier);
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.headers["access-control-allow-origin"]).toBe(HOME);
    expect(redeemed.headers["access-control-allow-credentials"]).toBeUndefined();
    const { token, scope } = redeemed.json() as { token: string; scope: string };
    expect(scope).toBe("link");
    // A token the server takes: legato.fm's signature, this server's id.
    const keys = new Map(h.keys.published.map((jwk) => [jwk.kid, importEd25519Jwk(jwk)!.key]));
    const verified = verifyLegatoToken(token, { keys, issuer: ISSUER, audience: server.serverId });
    expect(verified).toMatchObject({ ok: true, claims: { scope: "link", email: "rowan@example.com" } });
    // Still nothing on record: the server hasn't reported the link.
    expect(h.pairs()).toEqual([]);
    expect(h.credentials()).toEqual([]);

    const reported = await h.report(linkProof(server, token));
    expect(reported.statusCode).toBe(200);
    const { tunnel } = reported.json() as { tunnel: { credential: string } };
    expect(h.pairs()).toHaveLength(1);
    expect(h.credentials()).toEqual([h.pairs()[0]]);
    expect(tunnelCredentialHolder(h.db, tunnel.credential)).not.toBeNull();
  });

  it("leaves nothing on record when the token is never reported", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const { verifier, query } = h.start(homeServer().serverId);
    const code = codeFrom((await h.press(cookie, query)).json().redirect);
    expect((await h.redeem(code, verifier)).statusCode).toBe(200);
    expect(h.pairs()).toEqual([]);
    expect(h.credentials()).toEqual([]);
  });
});

describe("the link page", () => {
  it("never sends anyone anywhere from a request it can't finish", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const server = homeServer().serverId;
    const challenge = s256Challenge(randomBytes(32).toString("base64url"));
    for (const query of [
      {},
      { server, code_challenge: challenge },
      { server, return_to: "javascript:alert(1)", code_challenge: challenge },
      { server, return_to: "data:text/html,hi", code_challenge: challenge },
      { server, return_to: "ftp://192.168.1.20/", code_challenge: challenge },
      { server, return_to: "http://user:pass@192.168.1.20:8899/", code_challenge: challenge },
      { server, return_to: "/relative", code_challenge: challenge },
      { server: "not-a-server-id", return_to: `${HOME}/`, code_challenge: challenge },
      { server, return_to: `${HOME}/`, code_challenge: "short" },
    ]) {
      const res = await h.page(`/link?${new URLSearchParams(query as Record<string, string>)}`, cookie);
      expect(res.statusCode).toBe(400);
      expect(view(res.body)).toBe("bad_request");
      expect(res.headers.location).toBeUndefined();
      expect((await h.press(cookie, query)).statusCode).toBe(400);
    }
  });

  it("can't be framed, sends no Referer, runs only its own script, and isn't cached", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const res = await h.page(h.start(homeServer().serverId).url, cookie);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.body).toContain(`<script nonce="${nonce}">`);
    expect(res.body).toContain(`<style nonce="${nonce}">`);
    // A fresh nonce every time.
    expect(String((await h.page(h.start(homeServer().serverId).url, cookie)).headers["content-security-policy"])).not.toContain(nonce!);
  });

  it("shows the whole origin, so http and https, and the port, can be told apart", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const server = homeServer().serverId;
    expect((await h.page(h.start(server, "https://music.example/").url, cookie)).body).toContain(">https://music.example</p>");
    expect((await h.page(h.start(server, "http://music.example:8443/").url, cookie)).body).toContain(">http://music.example:8443</p>");
  });

  it("escapes the account and the host it shows", async () => {
    const h = setup();
    const { cookie } = h.signIn("g-2", "<img src=x onerror=alert(1)>");
    const res = await h.page(h.start(homeServer().serverId, "http://music.example:8899/</script>").url, cookie);
    expect(res.body).not.toContain("<img src=x");
    expect(res.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // The page's own script is the only one, and it ends where it should.
    expect(res.body.match(/<\/script>/g)).toHaveLength(1);
  });

  it("says linking isn't available when this relay can't sign", async () => {
    const h = setup({ signing: false });
    const { cookie } = h.signIn();
    const { url, query } = h.start(homeServer().serverId);
    const res = await h.page(url, cookie);
    expect(res.statusCode).toBe(503);
    expect(view(res.body)).toBe("unavailable");
    expect((await h.press(cookie, query)).statusCode).toBe(503);
  });

  it("only takes the link button from a signed-in session on its own page", async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const { query } = h.start(homeServer().serverId);
    expect((await h.app.inject({ method: "POST", url: "/link", payload: query })).statusCode).toBe(401);
    const cross = await h.press(cookie, query, "https://legato.fm");
    expect(cross.statusCode).toBe(403);
    expect(cross.json().reason).toBe("cross_origin");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM relay_link_codes").get()).toEqual({ n: 0 });
  });

  it("goes back to itself after sign-in only with a well-formed request", () => {
    const server = homeServer().serverId;
    const challenge = s256Challenge("v".repeat(43));
    const good = `/link?${new URLSearchParams({ server, return_to: `${HOME}/x?y=1#z`, code_challenge: challenge })}`;
    expect(linkReturnPath(good)).toBe(`/link?${new URLSearchParams({ server, return_to: `${HOME}/x`, code_challenge: challenge })}`);
    for (const bad of [
      `//evil.example${good}`,
      `https://evil.example${good}`,
      good.replace("/link?", "/linkx?"),
      `/link?server=${server}`,
      "/auth/me",
      undefined,
    ]) {
      expect(linkReturnPath(bad)).toBeNull();
    }
  });

  it("keeps a return address's origin and path, and drops its query and fragment", () => {
    expect(parseReturnTo("https://music.example/legato/?t=secret#x")?.href).toBe("https://music.example/legato/");
    expect(parseReturnTo("http://[::1]:5182")?.href).toBe("http://[::1]:5182/");
    expect(parseReturnTo("http://a".padEnd(2100, "a"))).toBeNull();
    // Short as typed, but six times longer once the path is percent-encoded.
    expect(parseReturnTo(`http://music.example/${"é".repeat(100)}`)).toBeNull();
  });

  it("keeps the sign-in's return cookie well under 4 KB, however long the address", async () => {
    const h = setup();
    const server = homeServer().serverId;
    // The longest address it takes, all of it characters that are encoded
    // again at each step: a lone % stays as it is in a URL's path.
    const origin = "http://music.example:8899";
    const longest = `${origin}/${"%".repeat(512 - origin.length - 1)}`;
    expect(parseReturnTo(longest)?.href).toBe(longest);
    expect(parseReturnTo(`${longest}%`)).toBeNull();

    const { url } = h.start(server, longest);
    const begin = await h.app.inject({ method: "GET", url: `/auth/github?return_to=${encodeURIComponent(url)}` });
    const setCookies = ([] as string[]).concat(begin.headers["set-cookie"] ?? []);
    const returnCookie = setCookies.find((c) => c.startsWith("relay_return_to="));
    expect(returnCookie).toBeDefined();
    expect(returnCookie!.length).toBeLessThan(3 * 1024);
  });

  it("clears a return left by an earlier sign-in when the next one has nowhere to go back to", async () => {
    const h = setup();
    const begin = await h.app.inject({ method: "GET", url: "/auth/github" });
    const setCookies = ([] as string[]).concat(begin.headers["set-cookie"] ?? []);
    const cleared = setCookies.find((c) => c.startsWith("relay_return_to="));
    expect(cleared).toMatch(/^relay_return_to=;/);
    expect(cleared).toContain("Expires=Thu, 01 Jan 1970");
  });

  it(`holds an account to ${OPEN_LINK_CODES_PER_ACCOUNT} links waiting to finish`, async () => {
    const h = setup();
    const { cookie } = h.signIn();
    const server = homeServer().serverId;
    const waiting: { code: string; verifier: string }[] = [];
    for (let i = 0; i < OPEN_LINK_CODES_PER_ACCOUNT; i++) {
      const { verifier, query } = h.start(server);
      const res = await h.press(cookie, query);
      expect(res.statusCode).toBe(200);
      waiting.push({ verifier, code: codeFrom(res.json().redirect) });
    }
    const refused = await h.press(cookie, h.start(server).query);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().reason).toBe("too_many");
    // Another account isn't held to this one's count.
    expect((await h.press(h.signIn("g-2", "Ana").cookie, h.start(server).query)).statusCode).toBe(200);
    // Spending one frees its place.
    expect((await h.redeem(waiting[0]!.code, waiting[0]!.verifier)).statusCode).toBe(200);
    expect((await h.press(cookie, h.start(server).query)).statusCode).toBe(200);
  });
});

describe("redeeming a link code", () => {
  async function minted(h: ReturnType<typeof setup>) {
    const { cookie } = h.signIn();
    const { verifier, query } = h.start(homeServer().serverId);
    return { verifier, code: codeFrom((await h.press(cookie, query)).json().redirect) };
  }

  it("is spent by a wrong verifier, so the right one can't try after it", async () => {
    const h = setup();
    const { code, verifier } = await minted(h);
    const wrong = await h.redeem(code, randomBytes(32).toString("base64url"));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().reason).toBe("mismatch");
    expect((await h.redeem(code, verifier)).json().reason).toBe("used");
  });

  it("works only from the origin it was sent to", async () => {
    const h = setup();
    const first = await minted(h);
    expect((await h.redeem(first.code, first.verifier, "http://evil.example")).json().reason).toBe("mismatch");
    const second = await minted(h);
    expect((await h.redeem(second.code, second.verifier, null)).json().reason).toBe("mismatch");
  });

  it("works once, and for five minutes", async () => {
    const h = setup();
    const once = await minted(h);
    expect((await h.redeem(once.code, once.verifier)).statusCode).toBe(200);
    expect((await h.redeem(once.code, once.verifier)).json().reason).toBe("used");

    const late = await minted(h);
    h.db.prepare("UPDATE relay_link_codes SET expires_at = datetime('now', '-1 second') WHERE used_at IS NULL").run();
    expect((await h.redeem(late.code, late.verifier)).json().reason).toBe("expired");
    expect((await h.redeem(randomBytes(32).toString("base64url"), late.verifier)).json().reason).toBe("not_found");
    expect((await h.redeem(late.code, "short")).json().reason).toBe("malformed");
  });

  const guess = () => randomBytes(32).toString("base64url");

  it("brakes guesses at codes from one address, and only those", async () => {
    const h = setup();
    const { code, verifier } = await minted(h);
    // Requests that couldn't be a code aren't counted, or even braked.
    for (const bad of ["short", `${guess()}x`, ""]) {
      for (let i = 0; i < 6; i++) expect((await h.redeem(bad, verifier)).json().reason).toBe("malformed");
    }
    // Nor is a wrong verifier, which burns its code, or a used code tried again.
    for (let i = 0; i < 6; i++) {
      const other = await minted(h);
      expect((await h.redeem(other.code, guess())).json().reason).toBe("mismatch");
      expect((await h.redeem(other.code, other.verifier)).json().reason).toBe("used");
    }
    // An unknown code is, and so is an expired one.
    const stale = await minted(h);
    h.db.prepare("UPDATE relay_link_codes SET expires_at = datetime('now', '-1 second') WHERE code_hash = ?").run(sha256Hex(stale.code));
    expect((await h.redeem(stale.code, stale.verifier)).json().reason).toBe("expired");
    for (let i = 0; i < 4; i++) expect((await h.redeem(guess(), verifier)).json().reason).toBe("not_found");
    const limited = await h.redeem(code, verifier);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().reason).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Without spending the code: from another address it still works.
    expect((await h.redeem(code, verifier, HOME, "203.0.113.9")).statusCode).toBe(200);
  });

  it("never locks everyone out, however many addresses guess", async () => {
    const h = setup();
    for (let i = 0; i < 60; i++) expect((await h.redeem(guess(), guess(), HOME, `198.51.100.${i}`)).json().reason).toBe("not_found");
    const { code, verifier } = await minted(h);
    expect((await h.redeem(code, verifier, HOME, "203.0.113.9")).statusCode).toBe(200);
  });

  // Issue #324: the brake counts an IPv6 address as its /64, as every
  // TokenLimiter does, so one host can't step through its own addresses.
  it("holds one IPv6 /64 to one allowance", async () => {
    const h = setup();
    for (let i = 1; i <= 5; i++) expect((await h.redeem(guess(), guess(), HOME, `2001:db8:1:2::${i}`)).json().reason).toBe("not_found");
    const { code, verifier } = await minted(h);
    expect((await h.redeem(code, verifier, HOME, "2001:db8:1:2::ffff")).json().reason).toBe("rate_limited");
    expect((await h.redeem(code, verifier, HOME, "2001:db8:1:3::1")).statusCode).toBe(200);
  });

  it("answers any origin's preflight, without credentials", async () => {
    const h = setup();
    const res = await h.app.inject({
      method: "OPTIONS",
      url: "/link/redeem",
      headers: { origin: "http://nas.local:8899", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://nas.local:8899");
    expect(res.headers["access-control-allow-headers"]).toBe("Content-Type");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("stores the code's hash and an HMAC of the address it went to, never either one", async () => {
    const h = setup();
    const { code } = await minted(h);
    const rows = h.db.prepare("SELECT * FROM relay_link_codes").all() as { return_origin_mac: string }[];
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain("192.168.1.20");
    // Not a plain hash, which anyone with relay.db could match by trying
    // every LAN address: it takes a key from the signing secret.
    expect(stored).not.toContain(sha256Hex(HOME));
    expect(rows[0]!.return_origin_mac).toBe(createHmac("sha256", h.keys.linkOriginKeys[0]!).update(HOME).digest("hex"));
    expect(signingKeys().linkOriginKeys[0]!.equals(h.keys.linkOriginKeys[0]!)).toBe(false);
  });

  it("still redeems a code minted just before the signing key rotated", async () => {
    const h = setup();
    const { user } = h.signIn();
    const next = signingKeys();
    const mint = () => {
      const { verifier, query } = h.start(homeServer().serverId);
      const result = mintLinkCode(h.db, user.id, parseLinkRequest(query)!, h.keys.linkOriginKeys[0]!);
      if (!result.ok) throw new Error("not minted");
      return { code: result.code, codeVerifier: verifier, origin: HOME };
    };
    // The new key signs first; the old one is still published second.
    expect(redeemLinkCode(h.db, mint(), [next.linkOriginKeys[0]!, h.keys.linkOriginKeys[0]!])).toMatchObject({ ok: true });
    // Once it's gone, so is every code it was the key for.
    expect(redeemLinkCode(h.db, mint(), next.linkOriginKeys)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("sweeps every code ten minutes after it was minted, at the next mint or redeem", async () => {
    const h = setup();
    const codes = () => (h.db.prepare("SELECT code_hash FROM relay_link_codes").all() as { code_hash: string }[]).map((r) => r.code_hash);
    const expireAgo = (code: string, ago: string) =>
      h.db.prepare("UPDATE relay_link_codes SET expires_at = datetime('now', ?) WHERE code_hash = ?").run(ago, sha256Hex(code));

    const old = await minted(h);
    const recent = await minted(h);
    // Minted ten minutes and a second ago, and nine minutes ago.
    expireAgo(old.code, "-301 seconds");
    expireAgo(recent.code, "-4 minutes");
    await h.redeem(guess(), guess());
    expect(codes()).toEqual([sha256Hex(recent.code)]);
    // Still on record until then, so a late try says why.
    expect((await h.redeem(recent.code, recent.verifier)).json().reason).toBe("expired");

    expireAgo(recent.code, "-301 seconds");
    const fresh = await minted(h);
    expect(codes()).toEqual([sha256Hex(fresh.code)]);

    const plan = h.db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM relay_link_codes WHERE expires_at <= datetime('now', '-5 minutes')")
      .all() as { detail: string }[];
    expect(plan.map((step) => step.detail).join(" ")).toContain("relay_link_codes_expires_at_idx");
  });
});
