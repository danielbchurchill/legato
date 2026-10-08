import { createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { installLegatoIdentity, LegatoIdentity } from "./legatoIdentity.js";
import { fakeLegatoFetch, makeTestKey, signTestToken, testClaims, TEST_ISSUER } from "./legato-test-keys.js";
import { serverIdForPublicKey } from "./serverKey.js";
import { createSession, LEGATO_SESSION_TTL_HOURS } from "./sessions.js";
import { buildTestApp, createOwnerForTest } from "./test-app.js";

// Issue #117's two server routes. POST /auth/identity lets a client check
// this server holds the key its id comes from before it hands over a
// legato.fm access token. POST /auth/legato/session swaps that token, once,
// for a session that never slides and ends when the account is unlinked.

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function setup() {
  const db = openDb(":memory:");
  const key = makeTestKey();
  const identity = new LegatoIdentity(db, { origin: TEST_ISSUER, fetch: fakeLegatoFetch(() => [key]).impl });
  installLegatoIdentity(db, identity);
  cleanups.push(() => identity.stop());
  const { app } = await buildTestApp(db);
  cleanups.push(() => void app.close());
  const now = () => Math.floor(Date.now() / 1000);
  const token = (overrides: Record<string, unknown> = {}) =>
    signTestToken(key, testClaims(identity.serverId(), now(), { jti: crypto.randomUUID(), ...overrides }));

  const { token: owner } = await createOwnerForTest(app);
  const link = await app.inject({
    method: "POST",
    url: "/api/v1/auth/legato/link",
    headers: { authorization: `Bearer ${owner}` },
    payload: { token: token({ scope: "link" }) },
  });
  if (link.statusCode !== 200) throw new Error(`link failed: ${link.body}`);
  return { db, app, identity, owner, token };
}

type Harness = Awaited<ReturnType<typeof setup>>;

function exchange(h: Harness, bearer: string) {
  return h.app.inject({ method: "POST", url: "/api/v1/auth/legato/session", headers: { authorization: `Bearer ${bearer}` } });
}

function sessionRow(h: Harness, token: string) {
  const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex");
  return h.db.prepare("SELECT expires_at, refreshed_at, legato_account_id FROM sessions WHERE token_hash = ?").get(hash) as
    | { expires_at: string; refreshed_at: string; legato_account_id: string | null }
    | undefined;
}

function me(h: Harness, token: string) {
  return h.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
}

describe("POST /auth/identity", () => {
  it("is public, and signs the client's nonce with the key the id is a hash of", async () => {
    const h = await setup();
    const nonce = "a-fresh-client-nonce-0123456789";
    const res = await h.app.inject({ method: "POST", url: "/api/v1/auth/identity", payload: { nonce } });
    expect(res.statusCode).toBe(200);
    const proof = res.json() as { serverId: string; publicKey: string; signature: string };
    expect(proof.serverId).toBe(h.identity.serverId());
    expect(serverIdForPublicKey(proof.publicKey)).toBe(proof.serverId);
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: proof.publicKey }, format: "jwk" });
    const message = `legato server identity proof\n${proof.serverId}\n${nonce}`;
    expect(verify(null, Buffer.from(message), key, Buffer.from(proof.signature, "base64url"))).toBe(true);

    const status = await h.app.inject({ method: "GET", url: "/api/v1/auth/status" });
    expect(status.json().legato.publicKey).toBe(proof.publicKey);
  });

  it("refuses a missing, short, or newline-carrying nonce", async () => {
    const h = await setup();
    for (const payload of [{}, { nonce: "short" }, { nonce: `${"a".repeat(20)}\nlegato.fm link proof` }, { nonce: 7 }]) {
      const res = await h.app.inject({ method: "POST", url: "/api/v1/auth/identity", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().reason).toBe("bad_nonce");
    }
  });
});

describe("POST /auth/legato/session", () => {
  it("swaps an access token for a session that opens the library and carries a media ticket", async () => {
    const h = await setup();
    const res = await exchange(h, h.token());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; mediaTicket: string; expiresAt: string; user: { role: string } };
    expect(body.user.role).toBe("owner");
    expect(body.mediaTicket).toBeTruthy();
    expect((await me(h, body.token)).json().user.role).toBe("owner");
    expect(sessionRow(h, body.token)?.legato_account_id).toBe("42");

    const lifetimeHours = (Date.parse(body.expiresAt) - Date.now()) / 3_600_000;
    expect(lifetimeHours).toBeGreaterThan(LEGATO_SESSION_TTL_HOURS - 0.1);
    expect(lifetimeHours).toBeLessThanOrEqual(LEGATO_SESSION_TTL_HOURS);
    expect(LEGATO_SESSION_TTL_HOURS).toBeLessThanOrEqual(24);
  });

  it("takes each access token once", async () => {
    const h = await setup();
    const access = h.token();
    expect((await exchange(h, access)).statusCode).toBe(200);
    const again = await exchange(h, access);
    expect(again.statusCode).toBe(409);
    expect(again.json().reason).toBe("token_used");
    expect((await exchange(h, h.token())).statusCode).toBe(200);
  });

  it("can't be called with a session, so a session can't mint sessions", async () => {
    const h = await setup();
    const res = await exchange(h, h.owner);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("legato_token_required");

    const legatoSession = (await exchange(h, h.token())).json().token as string;
    expect((await exchange(h, legatoSession)).json().reason).toBe("legato_token_required");
  });

  it("refuses a link token and a token for another server before the route runs", async () => {
    const h = await setup();
    expect((await exchange(h, h.token({ scope: "link" }))).json().reason).toBe("wrong_scope");
    expect((await exchange(h, h.token({ aud: "f".repeat(32) }))).statusCode).toBe(401);
  });

  it("doesn't slide past its cap, while a password session still does", async () => {
    const h = await setup();
    const legato = (await exchange(h, h.token())).json().token as string;
    const owner = h.owner;
    // Both look a day stale, which is when a sliding session moves forward.
    h.db.prepare("UPDATE sessions SET refreshed_at = datetime('now', '-2 days')").run();
    const before = sessionRow(h, legato)!.expires_at;

    expect((await me(h, legato)).statusCode).toBe(200);
    expect((await me(h, owner)).statusCode).toBe(200);
    expect(sessionRow(h, legato)!.expires_at).toBe(before);
    expect(Date.parse(`${sessionRow(h, owner)!.expires_at.replace(" ", "T")}Z`) - Date.now()).toBeGreaterThan(29 * 86_400_000);

    h.db.prepare(`UPDATE sessions SET expires_at = datetime('now', '-1 second') WHERE legato_account_id IS NOT NULL`).run();
    expect((await me(h, legato)).statusCode).toBe(401);
  });

  it("unlinking the account ends its legato.fm sessions at once, and leaves password sessions alone", async () => {
    const h = await setup();
    const legato = (await exchange(h, h.token())).json().token as string;
    const second = createSession(h.db, 1).token;
    const unlink = await h.app.inject({ method: "DELETE", url: "/api/v1/auth/legato/link", headers: { authorization: `Bearer ${h.owner}` } });
    expect(unlink.statusCode).toBe(200);

    expect(sessionRow(h, legato)).toBeUndefined();
    expect((await me(h, legato)).statusCode).toBe(401);
    expect((await me(h, h.owner)).json().user.role).toBe("owner");
    expect((await me(h, second)).json().user.role).toBe("owner");
  });

  it("linking a different account ends the old account's legato.fm sessions", async () => {
    const h = await setup();
    const legato = (await exchange(h, h.token())).json().token as string;
    const relink = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/legato/link",
      headers: { authorization: `Bearer ${h.owner}` },
      payload: { token: h.token({ scope: "link", sub: "43" }) },
    });
    expect(relink.statusCode).toBe(200);
    expect(sessionRow(h, legato)).toBeUndefined();
    expect((await exchange(h, h.token({ sub: "43" }))).statusCode).toBe(200);
  });

  it("prunes spent tokens once they've expired", async () => {
    const h = await setup();
    await exchange(h, h.token());
    h.db.prepare("UPDATE spent_access_tokens SET expires_at = datetime('now', '-1 minute')").run();
    await exchange(h, h.token());
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM spent_access_tokens").get()).toEqual({ n: 1 });
  });
});
