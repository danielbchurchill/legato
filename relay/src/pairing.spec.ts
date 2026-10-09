import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import { upsertUser } from "./accounts.js";
import { openDb } from "./db.js";
import { claimServerCode, mintTunnelCredential, redeemPairingCode, tunnelCredentialHolder } from "./pairing.js";

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

describe("mintTunnelCredential", () => {
  it("mints a credential tied to the given account, expiring about a year out", () => {
    const { token, expiresAt } = mintTunnelCredential(db, userId);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const daysOut = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(360);
    expect(daysOut).toBeLessThan(370);
  });
});

describe("tunnelCredentialHolder", () => {
  it("resolves a real credential back to its account and the server it was minted for", () => {
    const { token } = mintTunnelCredential(db, userId, "0123456789abcdef0123456789abcdef");
    expect(tunnelCredentialHolder(db, token)).toEqual({ relayUserId: userId, serverId: "0123456789abcdef0123456789abcdef" });
  });

  it("says when a credential from before migration 0006 names no server", () => {
    const { token } = mintTunnelCredential(db, userId);
    expect(tunnelCredentialHolder(db, token)).toEqual({ relayUserId: userId, serverId: null });
  });

  it("returns null for a credential that was never issued", () => {
    expect(tunnelCredentialHolder(db, "not-a-real-credential")).toBeNull();
  });

  it("returns null for an expired credential", () => {
    db.prepare(
      "INSERT INTO tunnel_credentials (token, relay_user_id, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))",
    ).run("expired-token", userId);
    expect(tunnelCredentialHolder(db, "expired-token")).toBeNull();
  });
});

describe("redeemPairingCode", () => {
  const SERVER_ID = "0123456789abcdef0123456789abcdef";
  const OTHER_SERVER_ID = "fedcba9876543210fedcba9876543210";

  // A code the account claimed for SERVER_ID, as the claim page does.
  function claimed(code = "K7QM-4XRD"): string {
    const result = claimServerCode(db, userId, code, SERVER_ID);
    if (!result.ok) throw new Error(result.reason);
    return result.code;
  }

  // Issue #237: the credential comes with the link the server reports
  // afterwards (linked-servers.ts), so redeeming mints none.
  it("marks the code used and says whose it was, minting no credential", () => {
    const code = claimed();

    const result = redeemPairingCode(db, code, SERVER_ID);

    expect(result).toEqual({ ok: true, relayUserId: userId });
    const row = db.prepare("SELECT used_at FROM pairing_codes WHERE code = ?").get(code) as { used_at: string | null };
    expect(row.used_at).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tunnel_credentials").get()).toEqual({ n: 0 });
  });

  it("accepts the code the way a person types it", () => {
    const code = claimed("K0QM-4X1D");
    // Lowercase, no dash, and every 0 and 1 typed as the letter it looks like.
    const typed = code.replace("-", "").toLowerCase().replace(/0/g, "o").replace(/1/g, "l");

    expect(redeemPairingCode(db, typed, SERVER_ID).ok).toBe(true);
  });

  // Issue #324: a code claimed for one server is nobody's to any other.
  it("answers any other server, about any code not bound to it, as if there were no such code, and spends nothing", () => {
    const live = claimed("K7QM-4XRD");
    const spent = claimed("SPNT-0000");
    redeemPairingCode(db, spent, SERVER_ID);
    db.prepare(
      "INSERT INTO pairing_codes (code, relay_user_id, server_id, expires_at) VALUES ('EXPD-0000', ?, ?, datetime('now', '-1 minute'))",
    ).run(userId, SERVER_ID);
    // A row from before #324, or one POST /pair/start minted before #353.
    const unbound = "NSRV-0000";
    db.prepare("INSERT INTO pairing_codes (code, relay_user_id, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))").run(
      unbound,
      userId,
    );

    for (const code of [live, spent, "EXPD-0000"]) {
      expect(redeemPairingCode(db, code, OTHER_SERVER_ID)).toEqual({ ok: false, reason: "not_found" });
    }
    expect(redeemPairingCode(db, unbound, SERVER_ID)).toEqual({ ok: false, reason: "not_found" });
    const unspent = db.prepare("SELECT code FROM pairing_codes WHERE used_at IS NULL ORDER BY code").all();
    expect(unspent).toEqual([{ code: "EXPD-0000" }, { code: live }, { code: unbound }].sort((a, b) => a.code.localeCompare(b.code)));
    expect(redeemPairingCode(db, live, SERVER_ID).ok).toBe(true);
  });

  it("rejects a code that was never issued", () => {
    const result = redeemPairingCode(db, "not-a-real-code", SERVER_ID);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a code that's already been redeemed", () => {
    const code = claimed();
    redeemPairingCode(db, code, SERVER_ID);

    const result = redeemPairingCode(db, code, SERVER_ID);
    expect(result).toEqual({ ok: false, reason: "used" });
  });

  it("rejects an expired code", () => {
    db.prepare(
      "INSERT INTO pairing_codes (code, relay_user_id, server_id, expires_at) VALUES (?, ?, ?, datetime('now', '-1 minute'))",
    ).run("EXPD-0000", userId, SERVER_ID);

    const result = redeemPairingCode(db, "EXPD-0000", SERVER_ID);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });
});
