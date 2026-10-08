import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { openDb } from "../db.js";
import { LegatoIdentity } from "./legatoIdentity.js";
import { TEST_ISSUER } from "./legato-test-keys.js";
import { ensureServerKey, linkProof, loadServerKey, serverIdForPublicKey, unlinkProof } from "./serverKey.js";

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

  it("logs the id change once at startup, and asks for a relink only when there's a link to redo", () => {
    const lines: [string, string][] = [];
    const log = (level: "info" | "warn", message: string) => void lines.push([level, message]);

    const db = openDb(":memory:");
    const old = identityRow(db).server_id;
    const identity = new LegatoIdentity(db, { origin: TEST_ISSUER, log });
    expect(lines).toEqual([
      ["warn", `legato.fm: this server's id is now ${identity.serverId()} (was ${old}), made from its new identity key.`],
    ]);
    new LegatoIdentity(db, { origin: TEST_ISSUER, log });
    expect(lines).toHaveLength(1);

    const linked = openDb(":memory:");
    linked.prepare("INSERT INTO users (provider, provider_user_id, role, legato_account_id) VALUES ('google', 'g', 'legacy', '42')").run();
    lines.length = 0;
    new LegatoIdentity(linked, { origin: TEST_ISSUER, log });
    expect(lines[0]![1]).toMatch(/Link its legato.fm account again/);
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
});
