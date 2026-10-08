import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import { upsertUser } from "./accounts.js";
import { openDb } from "./db.js";
import { getRelayUserIdByCredential, mintPairingCode, mintTunnelCredential, redeemPairingCode } from "./pairing.js";

let db: Database;
let userId: number;

beforeEach(() => {
  db = openDb(":memory:");
  userId = upsertUser(db, "google", {
    providerUserId: "pairing-user",
    email: null,
    displayName: null,
    avatarUrl: null,
  }).id;
});

describe("mintPairingCode", () => {
  it("mints a code tied to the given account, expiring in the future", () => {
    const { code, expiresAt } = mintPairingCode(db, userId);

    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const row = db.prepare("SELECT relay_user_id, used_at FROM pairing_codes WHERE code = ?").get(code) as {
      relay_user_id: number;
      used_at: string | null;
    };
    expect(row.relay_user_id).toBe(userId);
    expect(row.used_at).toBeNull();
  });

  it("produces a different code on every call", () => {
    expect(mintPairingCode(db, userId).code).not.toBe(mintPairingCode(db, userId).code);
  });
});

describe("mintTunnelCredential", () => {
  it("mints a credential tied to the given account, expiring about a year out", () => {
    const { token, expiresAt } = mintTunnelCredential(db, userId);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const daysOut = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(360);
    expect(daysOut).toBeLessThan(370);
  });
});

describe("getRelayUserIdByCredential", () => {
  it("resolves a real credential back to its owning account", () => {
    const { token } = mintTunnelCredential(db, userId);
    expect(getRelayUserIdByCredential(db, token)).toBe(userId);
  });

  it("returns null for a credential that was never issued", () => {
    expect(getRelayUserIdByCredential(db, "not-a-real-credential")).toBeNull();
  });

  it("returns null for an expired credential", () => {
    db.prepare(
      "INSERT INTO tunnel_credentials (token, relay_user_id, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))",
    ).run("expired-token", userId);
    expect(getRelayUserIdByCredential(db, "expired-token")).toBeNull();
  });
});

describe("redeemPairingCode", () => {
  // Issue #237: the credential comes with the link the server reports
  // afterwards (linked-servers.ts), so redeeming mints none.
  it("marks the code used and says whose it was, minting no credential", () => {
    const { code } = mintPairingCode(db, userId);

    const result = redeemPairingCode(db, code);

    expect(result).toEqual({ ok: true, relayUserId: userId });
    const row = db.prepare("SELECT used_at FROM pairing_codes WHERE code = ?").get(code) as { used_at: string | null };
    expect(row.used_at).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tunnel_credentials").get()).toEqual({ n: 0 });
  });

  it("accepts the code the way a person types it", () => {
    const { code } = mintPairingCode(db, userId);
    // Lowercase, no dash, and every 0 and 1 typed as the letter it looks like.
    const typed = code.replace("-", "").toLowerCase().replace(/0/g, "o").replace(/1/g, "l");

    expect(redeemPairingCode(db, typed).ok).toBe(true);
  });

  it("draws again when a new code clashes with a stored one", () => {
    db.prepare(
      "INSERT INTO pairing_codes (code, relay_user_id, expires_at) VALUES ('K7QM-4XRD', ?, datetime('now', '+10 minutes'))",
    ).run(userId);
    const draws = ["K7QM-4XRD", "K7QM-4XRD", "AAAA-BBBB"];
    const { code } = mintPairingCode(db, userId, () => draws.shift()!);
    expect(code).toBe("AAAA-BBBB");
  });

  it("rejects a code that was never issued", () => {
    const result = redeemPairingCode(db, "not-a-real-code");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a code that's already been redeemed", () => {
    const { code } = mintPairingCode(db, userId);
    redeemPairingCode(db, code);

    const result = redeemPairingCode(db, code);
    expect(result).toEqual({ ok: false, reason: "used" });
  });

  it("rejects an expired code", () => {
    db.prepare(
      "INSERT INTO pairing_codes (code, relay_user_id, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))",
    ).run("EXPD-0000", userId);

    const result = redeemPairingCode(db, "EXPD-0000");
    expect(result).toEqual({ ok: false, reason: "expired" });
  });
});
