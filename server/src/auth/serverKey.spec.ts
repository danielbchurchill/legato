import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { LegatoIdentity } from "./legatoIdentity.js";
import { TEST_ISSUER } from "./legato-test-keys.js";
import { ensureServerKey, identityProof, linkProof, loadServerKey, serverIdForPublicKey, unlinkProof } from "./serverKey.js";

// Issue #231, migration 0037: the identity key this server proves its id
// with. relay/src/linked-servers.spec.ts runs these proofs through the
// relay's real checks; this file holds the server's side of the contract.

function identityRow(db: ReturnType<typeof openDb>) {
  return db.prepare("SELECT server_id, private_key FROM server_identity WHERE id = 1").get() as {
    server_id: string;
    private_key: string | null;
  };
}

function verifies(publicKey: string, message: string, signature: string): boolean {
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
  return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"));
}

describe("ensureServerKey", () => {
  it("makes the key once and moves the random 0032 id onto it", () => {
    const db = openDb(":memory:");
    const before = identityRow(db);
    expect(before.private_key).toBeNull();

    const moved = ensureServerKey(db);
    const after = identityRow(db);
    expect(moved).toEqual({ from: before.server_id, to: after.server_id });
    expect(after.server_id).not.toBe(before.server_id);
    expect(after.server_id).toMatch(/^[0-9a-f]{32}$/);
    expect(after.private_key).toContain("BEGIN PRIVATE KEY");

    const key = loadServerKey(db);
    expect(key.serverId).toBe(after.server_id);
    expect(serverIdForPublicKey(key.publicKey)).toBe(after.server_id);

    expect(ensureServerKey(db)).toBeNull();
    expect(identityRow(db)).toEqual(after);
  });

  it("gives every server its own key and id", () => {
    const a = loadServerKey(openDb(":memory:"));
    const b = loadServerKey(openDb(":memory:"));
    expect(a.serverId).not.toBe(b.serverId);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

// Issue #329: when the move onto the key is worth a line in the log.
describe("the id change at startup", () => {
  function start(db: ReturnType<typeof openDb>) {
    const lines: [string, string][] = [];
    const before = identityRow(db).server_id;
    const identity = new LegatoIdentity(db, { origin: TEST_ISSUER, log: (level, message) => void lines.push([level, message]) });
    return { lines, before, after: identity.serverId() };
  }

  // A server from before 0037, as the first start after the upgrade finds
  // it: an owner, 0032's random id, no key yet.
  function upgraded() {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (provider, provider_user_id, password_hash, role) VALUES ('local', 'owner', 'x', 'owner')").run();
    return db;
  }

  it("says nothing on a brand-new server, whose first id lived for under a second", () => {
    const db = openDb(":memory:");
    const { lines, before, after } = start(db);
    expect(lines).toEqual([]);
    expect(after).not.toBe(before);
    expect(identityRow(db).private_key).toContain("BEGIN PRIVATE KEY");
  });

  it("says nothing on an upgraded server that never linked or contacted legato.fm", () => {
    const db = upgraded();
    const { lines, before, after } = start(db);
    expect(lines).toEqual([]);
    expect(after).not.toBe(before);
  });

  it("warns once on an upgraded server that was linked, and asks for the link again", () => {
    const db = upgraded();
    db.prepare("UPDATE users SET legato_account_id = '42'").run();
    db.prepare("UPDATE server_identity SET jwks = '{\"keys\":[]}', jwks_fetched_at = datetime('now')").run();
    const { lines, before, after } = start(db);
    expect(lines).toEqual([
      [
        "warn",
        `legato.fm: this server's id is now ${after} (was ${before}), made from its new identity key. ` +
          "Link its legato.fm account again: legato.fm only opens servers that reported their link.",
      ],
    ]);
    expect(start(db).lines).toEqual([]);
  });

  it("warns, without asking for a link, when legato.fm knew the id but nothing's linked now", () => {
    const db = upgraded();
    db.prepare("UPDATE server_identity SET jwks = '{\"keys\":[]}', jwks_fetched_at = datetime('now')").run();
    const { lines, before, after } = start(db);
    expect(lines).toEqual([["warn", `legato.fm: this server's id is now ${after} (was ${before}), made from its new identity key.`]]);
  });
});

describe("proofs", () => {
  it("a link proof is the link token, signed", () => {
    const key = loadServerKey(openDb(":memory:"));
    const proof = linkProof(key, "a.b.c");
    expect(proof).toEqual({ publicKey: key.publicKey, linkToken: "a.b.c", signature: proof.signature });
    expect(verifies(key.publicKey, "legato.fm link proof\na.b.c", proof.signature)).toBe(true);
    expect(verifies(key.publicKey, "legato.fm link proof\na.b.d", proof.signature)).toBe(false);
  });

  it("an unlink proof names the service, server, account and time, with a fresh nonce each time", () => {
    const key = loadServerKey(openDb(":memory:"));
    const first = unlinkProof(key, { issuer: TEST_ISSUER, accountId: "42", nowSeconds: 1_800_000_000 });
    const second = unlinkProof(key, { issuer: TEST_ISSUER, accountId: "42", nowSeconds: 1_800_000_000 });
    expect(first.nonce).not.toBe(second.nonce);
    expect(first).toMatchObject({ publicKey: key.publicKey, accountId: "42", issuedAt: 1_800_000_000 });
    const message = `legato.fm unlink proof\n${TEST_ISSUER}\n${key.serverId}\n42\n1800000000\n${first.nonce}`;
    expect(verifies(key.publicKey, message, first.signature)).toBe(true);
  });

  // Issue #117: what a client checks before it sends this server an access
  // token. Its own prefix, so the same key's signature over a client's
  // nonce can never stand in for a link or unlink proof.
  it("an identity proof signs the server id and the client's nonce under its own prefix", () => {
    const key = loadServerKey(openDb(":memory:"));
    const proof = identityProof(key, "client-nonce-0123456789");
    expect(proof).toEqual({ serverId: key.serverId, publicKey: key.publicKey, signature: proof.signature });
    expect(verifies(key.publicKey, `legato server identity proof\n${key.serverId}\nclient-nonce-0123456789`, proof.signature)).toBe(true);
    expect(verifies(key.publicKey, "legato.fm link proof\nclient-nonce-0123456789", proof.signature)).toBe(false);
  });
});
