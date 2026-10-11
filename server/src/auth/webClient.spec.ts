import { createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { installLegatoIdentity, LegatoIdentity } from "./legatoIdentity.js";
import { fakeLegatoFetch, makeTestKey, signTestToken, testClaims, TEST_ISSUER } from "./legato-test-keys.js";
import {
  loadServerKey,
  serverIdForPublicKey,
  WEB_CLIENT_STATEMENT_TTL_SECONDS,
  webClientStatement,
  webClientStatementMessage,
} from "./serverKey.js";
import { buildTestApp, createOwnerForTest } from "./test-app.js";

// Issue #365: POST /api/v1/auth/legato/web-client, this server vouching for
// a page it served so that page can sign in to legato.fm and reach it
// through the relay. legato.fm checks the signature against the key the
// link proved (relay/src/routes/connect-page.ts).

const PAGE = "http://192.168.1.20:8899";
const CHALLENGE = "a".repeat(43);

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function setup({ link = true } = {}) {
  const db = openDb(":memory:");
  const key = makeTestKey();
  const identity = new LegatoIdentity(db, { origin: TEST_ISSUER, fetch: fakeLegatoFetch(() => [key]).impl });
  installLegatoIdentity(db, identity);
  cleanups.push(() => identity.stop());
  const { app } = await buildTestApp(db);
  cleanups.push(() => void app.close());
  const { token: owner } = await createOwnerForTest(app);
  if (link) {
    const now = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/legato/link",
      headers: { authorization: `Bearer ${owner}` },
      payload: { token: signTestToken(key, testClaims(identity.serverId(), now, { jti: crypto.randomUUID(), scope: "link" })) },
    });
    if (res.statusCode !== 200) throw new Error(`link failed: ${res.body}`);
  }
  const ask = (headers: Record<string, string>, payload: unknown = { codeChallenge: CHALLENGE }) =>
    app.inject({ method: "POST", url: "/api/v1/auth/legato/web-client", headers, payload: payload as object });
  return { app, identity, owner, ask };
}

describe("POST /api/v1/auth/legato/web-client", () => {
  it("signs, for the owner's own page, a statement legato.fm can check against this server's key", async () => {
    const h = await setup();
    const before = Math.floor(Date.now() / 1000);
    const res = await h.ask({ authorization: `Bearer ${h.owner}`, origin: PAGE, host: "192.168.1.20:8899" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      serverId: string;
      origin: string;
      codeChallenge: string;
      expiresAt: number;
      name: string;
      signature: string;
      publicKey?: string;
    };
    expect(body.serverId).toBe(h.identity.serverId());
    expect(body.origin).toBe(PAGE);
    expect(body.codeChallenge).toBe(CHALLENGE);
    expect(body.expiresAt - before).toBeGreaterThanOrEqual(WEB_CLIENT_STATEMENT_TTL_SECONDS);
    expect(body.expiresAt - before).toBeLessThanOrEqual(WEB_CLIENT_STATEMENT_TTL_SECONDS + 2);

    // The key the identity proof shows is the one legato.fm recorded at
    // link time, and it verifies this statement.
    const proof = await h.app.inject({ method: "POST", url: "/api/v1/auth/identity", payload: { nonce: "n".repeat(16) } });
    const { publicKey } = proof.json() as { publicKey: string };
    expect(serverIdForPublicKey(publicKey)).toBe(body.serverId);
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    expect(verify(null, Buffer.from(webClientStatementMessage(body)), key, Buffer.from(body.signature, "base64url"))).toBe(true);
    // Any field changed, and it no longer verifies.
    for (const changed of [
      { ...body, origin: "http://evil.example" },
      { ...body, expiresAt: body.expiresAt + 600 },
    ]) {
      expect(verify(null, Buffer.from(webClientStatementMessage(changed)), key, Buffer.from(body.signature, "base64url"))).toBe(false);
    }
  });

  it("refuses another page's origin, a request with no origin, and one the tunnel brought", async () => {
    const h = await setup();
    const owner = { authorization: `Bearer ${h.owner}` };
    for (const headers of [
      { ...owner, origin: "http://evil.example", host: "192.168.1.20:8899" },
      { ...owner, origin: "http://192.168.1.20:8900", host: "192.168.1.20:8899" },
      { ...owner, host: "192.168.1.20:8899" },
      // What a request through legato.fm looks like here: replayed on
      // loopback, marked by the tunnel client.
      { ...owner, origin: "http://127.0.0.1:8899", host: "127.0.0.1:8899", "x-legato-tunnel": "203.0.113.9" },
    ]) {
      const res = await h.ask(headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ reason: "cross_origin" });
    }
  });

  it("is the owner's alone, wants a well-formed challenge, and needs the server linked", async () => {
    const h = await setup();
    const page = { origin: PAGE, host: "192.168.1.20:8899" };
    expect((await h.ask(page)).statusCode).toBe(401);
    expect((await h.ask({ ...page, authorization: `Bearer ${h.owner}` }, { codeChallenge: "short" })).json()).toMatchObject({
      reason: "bad_challenge",
    });

    const unlinked = await setup({ link: false });
    const res = await unlinked.ask({ ...page, authorization: `Bearer ${unlinked.owner}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "not_linked" });
  });

  it("keeps the name it shows to one line", () => {
    const key = loadServerKey(openDb(":memory:"));
    const statement = webClientStatement(key, { origin: PAGE, codeChallenge: CHALLENGE, name: "Living\nroom", nowSeconds: 1_800_000_000 });
    expect(statement.name).toBe("Living room");
    expect(webClientStatementMessage(statement)).toBe(
      `legato web client\n${key.serverId}\n${PAGE}\n${CHALLENGE}\n${1_800_000_000 + WEB_CLIENT_STATEMENT_TTL_SECONDS}\nLiving room`,
    );
  });
});
