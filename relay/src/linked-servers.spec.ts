import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
// The home server's real proof signer, not a copy: the point is that what a
// server sends is exactly what this relay accepts, and nothing else is.
import { linkProof, unlinkProof, serverIdForPublicKey as serverSideId, type ServerKey } from "../../server/src/auth/serverKey.js";
import { createSession, upsertUser } from "./accounts.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { acceptUnlinkProof, isLinkedServer, serverIdForPublicKey, UNLINK_PROOF_WINDOW_SECONDS } from "./linked-servers.js";
import { parseSigningKeys, signServerToken, type SigningKeys } from "./signing-keys.js";
import type { Database } from "./sqlite.js";

// Issue #231: legato.fm signs `access` only for (account, server) pairs it
// has on record, and records one only when the server proves the id is its
// own. Every proof here is made by server/src/auth/serverKey.ts.

const ISSUER = "https://auth.legato.test";

function signingKeys(): SigningKeys {
  const { privateKey } = generateKeyPairSync("ed25519");
  return parseSigningKeys(JSON.stringify([{ privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) }]))!;
}

// A home server's identity key, the way serverKey.ts makes one.
function homeServer(): ServerKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
  return { serverId: serverSideId(publicKey), publicKey, privateKey };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function setup() {
  const db = openDb(":memory:");
  const keys = signingKeys();
  const app = buildApp({ db, auth: { config: { callbackBaseUrl: ISSUER }, signingKeys: keys } });
  apps.push(app);

  const signIn = (providerUserId = "g-1") => {
    const user = upsertUser(db, "google", {
      providerUserId,
      email: `${providerUserId}@example.com`,
      emailVerified: true,
      displayName: providerUserId,
      avatarUrl: null,
    });
    return { user, headers: { authorization: `Bearer ${createSession(db, user.id).token}` } };
  };

  const serverToken = async (headers: Record<string, string>, serverId: string, scope?: string) => {
    const res = await app.inject({ method: "POST", url: "/auth/server-token", headers, payload: { serverId, scope } });
    return res.json() as { token: string; scope: "access" | "link" };
  };

  const postLink = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/linked-servers", payload: body });
  const postUnlink = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/linked-servers/unlink", payload: body });

  // The whole link as it happens for real: a link token for the server, and
  // the server's signed report of it.
  const link = async (headers: Record<string, string>, server: ServerKey) => {
    const { token } = await serverToken(headers, server.serverId, "link");
    return postLink(linkProof(server, token));
  };

  return { db, app, keys, signIn, serverToken, postLink, postUnlink, link };
}

const now = () => Math.floor(Date.now() / 1000);

describe("the server id", () => {
  it("is derived the same way on both sides", () => {
    for (let i = 0; i < 5; i++) {
      const server = homeServer();
      expect(serverIdForPublicKey(server.publicKey)).toBe(server.serverId);
      expect(server.serverId).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe("POST /auth/server-token signs access only for linked servers", () => {
  it("signs link for an id the account never linked", async () => {
    const h = setup();
    const { headers } = h.signIn();
    expect((await h.serverToken(headers, homeServer().serverId)).scope).toBe("link");
    expect((await h.serverToken(headers, "0123456789abcdef0123456789abcdef", "access")).scope).toBe("link");
  });

  it("signs access once the server proves the link, for that account and that server only", async () => {
    const h = setup();
    const owner = h.signIn("owner");
    const stranger = h.signIn("stranger");
    const server = homeServer();
    const other = homeServer();

    const res = await h.link(owner.headers, server);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ linked: { accountId: String(owner.user.id), serverId: server.serverId } });

    expect((await h.serverToken(owner.headers, server.serverId)).scope).toBe("access");
    expect((await h.serverToken(owner.headers, other.serverId)).scope).toBe("link");
    expect((await h.serverToken(stranger.headers, server.serverId)).scope).toBe("link");
  });

  it("still signs link when the client asks for it, so a linked server can be linked again", async () => {
    const h = setup();
    const { headers } = h.signIn();
    const server = homeServer();
    await h.link(headers, server);
    expect((await h.serverToken(headers, server.serverId, "link")).scope).toBe("link");
    expect((await h.link(headers, server)).statusCode).toBe(200);
    expect((await h.serverToken(headers, server.serverId)).scope).toBe("access");
  });

  it("400s a scope that isn't access or link", async () => {
    const h = setup();
    const { headers } = h.signIn();
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/server-token",
      headers,
      payload: { serverId: homeServer().serverId, scope: "admin" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe("bad_scope");
  });
});

describe("a proof can't be used by a different server", () => {
  it("refuses another server's key, whatever it signs", async () => {
    const h = setup();
    const { headers } = h.signIn();
    const real = homeServer();
    const hostile = homeServer();
    // The hostile server claimed the real one's public id, so the visitor's
    // client asked legato.fm for a token for that id and handed it over.
    const { token } = await h.serverToken(headers, real.serverId);

    const ownKey = await h.postLink(linkProof(hostile, token));
    expect(ownKey.statusCode).toBe(403);
    expect(ownKey.json().reason).toBe("wrong_key");

    // Naming the real server's public key doesn't help without its private key.
    const borrowed = { ...linkProof(hostile, token), publicKey: real.publicKey };
    expect((await h.postLink(borrowed)).json().reason).toBe("bad_signature");

    expect((await h.serverToken(headers, real.serverId)).scope).toBe("link");
  });

  it("refuses a signature over a different token, and an unlink proof posted as a link", async () => {
    const h = setup();
    const { headers } = h.signIn();
    const server = homeServer();
    const first = await h.serverToken(headers, server.serverId);
    const second = await h.serverToken(headers, server.serverId);
    const swapped = { ...linkProof(server, first.token), linkToken: second.token };
    expect((await h.postLink(swapped)).json().reason).toBe("bad_signature");

    const unlink = unlinkProof(server, { issuer: ISSUER, accountId: "1", nowSeconds: now() });
    expect((await h.postLink({ ...unlink, linkToken: first.token })).json().reason).toBe("bad_signature");
  });

  it("a server's own link token links only its own id", async () => {
    const h = setup();
    const { headers } = h.signIn();
    const real = homeServer();
    const hostile = homeServer();
    expect((await h.link(headers, hostile)).statusCode).toBe(200);
    expect((await h.serverToken(headers, hostile.serverId)).scope).toBe("access");
    expect((await h.serverToken(headers, real.serverId)).scope).toBe("link");
  });
});

describe("a link proof works once", () => {
  it("refuses the same proof twice", async () => {
    const h = setup();
    const { headers } = h.signIn();
    const server = homeServer();
    const { token } = await h.serverToken(headers, server.serverId);
    const proof = linkProof(server, token);
    expect((await h.postLink(proof)).statusCode).toBe(200);
    const again = await h.postLink(proof);
    expect(again.statusCode).toBe(409);
    expect(again.json().reason).toBe("used");
  });

  it("a copy can't bring back a pair the owner removed", async () => {
    const h = setup();
    const { user, headers } = h.signIn();
    const server = homeServer();
    const { token } = await h.serverToken(headers, server.serverId);
    const proof = linkProof(server, token);
    await h.postLink(proof);
    await h.postUnlink(unlinkProof(server, { issuer: ISSUER, accountId: String(user.id), nowSeconds: now() }));
    expect((await h.postLink(proof)).json().reason).toBe("used");
    expect(isLinkedServer(h.db, user.id, server.serverId)).toBe(false);
  });

  it("takes only a live link token this service signed", async () => {
    const h = setup();
    const { user, headers } = h.signIn();
    const server = homeServer();
    const sign = (keys: SigningKeys, scope: "access" | "link", options: { issuer?: string; nowSeconds?: number } = {}) =>
      signServerToken(keys, { issuer: options.issuer ?? ISSUER, user, serverId: server.serverId, scope, nowSeconds: options.nowSeconds })
        .token;

    // An access token reaches a server on every request; it mustn't record anything.
    const refusals = [
      sign(h.keys, "access"),
      sign(h.keys, "link", { nowSeconds: now() - 11 * 60 }),
      sign(h.keys, "link", { issuer: "https://elsewhere.test" }),
      sign(signingKeys(), "link"),
      "not.a.token",
    ];
    for (const token of refusals) {
      const res = await h.postLink(linkProof(server, token));
      expect(res.statusCode).toBe(401);
      expect(res.json().reason).toBe("bad_token");
    }
    expect((await h.serverToken(headers, server.serverId)).scope).toBe("link");
  });

  it("400s a body that isn't a proof", async () => {
    const h = setup();
    for (const body of [{}, { publicKey: 1, linkToken: "a", signature: "b" }]) {
      expect((await h.postLink(body)).statusCode).toBe(400);
    }
  });
});

describe("unlinking and revoking remove the pair", () => {
  it("the server's signed unlink removes it, once", async () => {
    const h = setup();
    const { user, headers } = h.signIn();
    const server = homeServer();
    await h.link(headers, server);

    const proof = unlinkProof(server, { issuer: ISSUER, accountId: String(user.id), nowSeconds: now() });
    const res = await h.postUnlink(proof);
    expect(res.json()).toEqual({ unlinked: true });
    expect((await h.serverToken(headers, server.serverId)).scope).toBe("link");

    // Linked again, the old unlink proof can't undo it.
    await h.link(headers, server);
    expect((await h.postUnlink(proof)).json().reason).toBe("used");
    expect((await h.serverToken(headers, server.serverId)).scope).toBe("access");
  });

  it("another server can't unlink it, and a proof for another service or an old one is refused", async () => {
    const h = setup();
    const { user, headers } = h.signIn();
    const server = homeServer();
    await h.link(headers, server);
    const accountId = String(user.id);

    const hostile = await h.postUnlink(unlinkProof(homeServer(), { issuer: ISSUER, accountId, nowSeconds: now() }));
    expect(hostile.json()).toEqual({ unlinked: false });

    const borrowed = { ...unlinkProof(homeServer(), { issuer: ISSUER, accountId, nowSeconds: now() }), publicKey: server.publicKey };
    expect((await h.postUnlink(borrowed)).json().reason).toBe("bad_signature");

    const elsewhere = unlinkProof(server, { issuer: "https://elsewhere.test", accountId, nowSeconds: now() });
    expect((await h.postUnlink(elsewhere)).json().reason).toBe("bad_signature");

    const old = unlinkProof(server, { issuer: ISSUER, accountId, nowSeconds: now() - UNLINK_PROOF_WINDOW_SECONDS - 60 });
    expect((await h.postUnlink(old)).json().reason).toBe("stale");

    expect(
      (await h.postUnlink({ ...unlinkProof(server, { issuer: ISSUER, accountId, nowSeconds: now() }), accountId: "x" })).statusCode,
    ).toBe(400);
    expect((await h.serverToken(headers, server.serverId)).scope).toBe("access");
  });

  it("the account can revoke a server itself, and only its own pair", async () => {
    const h = setup();
    const owner = h.signIn("owner");
    const friend = h.signIn("friend");
    const server = homeServer();
    await h.link(owner.headers, server);
    await h.link(friend.headers, server);

    const url = `/linked-servers/${server.serverId}`;
    expect((await h.app.inject({ method: "DELETE", url })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "DELETE", url: "/linked-servers/nope", headers: owner.headers })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "DELETE", url, headers: owner.headers })).json()).toEqual({ unlinked: true });
    expect((await h.app.inject({ method: "DELETE", url, headers: owner.headers })).json()).toEqual({ unlinked: false });

    expect((await h.serverToken(owner.headers, server.serverId)).scope).toBe("link");
    expect((await h.serverToken(friend.headers, server.serverId)).scope).toBe("access");
  });

  it("deleting the account takes its pairs with it", async () => {
    const h = setup();
    const { user, headers } = h.signIn();
    await h.link(headers, homeServer());
    h.db.prepare("DELETE FROM relay_users WHERE id = ?").run(user.id);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM linked_servers").get()).toEqual({ n: 0 });
  });
});

describe("spent proofs", () => {
  const count = (db: Database) => (db.prepare("SELECT COUNT(*) AS n FROM spent_server_proofs").get() as { n: number }).n;

  it("an unlink with no pair to remove writes nothing", async () => {
    const h = setup();
    const { user } = h.signIn();
    for (let i = 0; i < 3; i++) {
      const res = await h.postUnlink(unlinkProof(homeServer(), { issuer: ISSUER, accountId: String(user.id), nowSeconds: now() }));
      expect(res.json()).toEqual({ unlinked: false });
    }
    expect(count(h.db)).toBe(0);
  });

  it("are kept only until the proof would have expired anyway", async () => {
    const h = setup();
    const { user, headers } = h.signIn();
    const server = homeServer();
    await h.link(headers, server);
    expect(count(h.db)).toBe(1);

    const later = now() + 11 * 60;
    const proof = unlinkProof(server, { issuer: ISSUER, accountId: String(user.id), nowSeconds: later });
    expect(acceptUnlinkProof(h.db, ISSUER, proof, later)).toMatchObject({ ok: true, changed: true });
    expect(count(h.db)).toBe(1);
  });
});
