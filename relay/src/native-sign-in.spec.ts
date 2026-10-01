import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "./sqlite.js";
import { upsertUser } from "./accounts.js";
import { openDb } from "./db.js";
import {
  createNativeRequest,
  isLoopbackRedirect,
  mintAuthCode,
  parseNativeStart,
  redeemAuthCode,
  s256Challenge,
  sha256Hex,
  takeNativeRequest,
} from "./native-sign-in.js";

// RFC 7636 Appendix B's worked example, so the S256 transform is checked
// against the spec's own numbers rather than against itself.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://127.0.0.1:53682/callback";

let db: Database;
let userId: number;

beforeEach(() => {
  db = openDb(":memory:");
  userId = upsertUser(db, "github", {
    providerUserId: "native-user",
    email: null,
    displayName: null,
    avatarUrl: null,
  }).id;
});

describe("s256Challenge", () => {
  it("matches RFC 7636 Appendix B", () => {
    expect(s256Challenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });
});

describe("isLoopbackRedirect", () => {
  it("accepts 127.0.0.1 and [::1] on any explicit port, at the fixed path", () => {
    expect(isLoopbackRedirect("http://127.0.0.1:1/callback")).toBe(true);
    expect(isLoopbackRedirect("http://127.0.0.1:65535/callback")).toBe(true);
    expect(isLoopbackRedirect("http://[::1]:53682/callback")).toBe(true);
  });

  it.each([
    ["a public host", "http://evil.example:53682/callback"],
    ["localhost, which can resolve elsewhere", "http://localhost:53682/callback"],
    ["https", "https://127.0.0.1:53682/callback"],
    ["no port", "http://127.0.0.1/callback"],
    ["port 0", "http://127.0.0.1:0/callback"],
    ["another path", "http://127.0.0.1:53682/other"],
    ["a trailing slash", "http://127.0.0.1:53682/callback/"],
    ["a query", "http://127.0.0.1:53682/callback?x=1"],
    ["a fragment", "http://127.0.0.1:53682/callback#x"],
    ["userinfo", "http://user@127.0.0.1:53682/callback"],
    ["a non-canonical IPv4 literal", "http://127.000.000.001:53682/callback"],
    ["a leading-zero port", "http://127.0.0.1:053682/callback"],
    ["another loopback address", "http://127.0.0.2:53682/callback"],
    ["a lookalike host", "http://127.0.0.1.evil.example:53682/callback"],
    ["not a URL", "127.0.0.1:53682/callback"],
  ])("rejects %s", (_label, uri) => {
    expect(isLoopbackRedirect(uri)).toBe(false);
  });
});

describe("parseNativeStart", () => {
  it("treats a request with no native parameters as today's browser sign-in", () => {
    expect(parseNativeStart({})).toEqual({ kind: "browser" });
  });

  it("accepts an S256 challenge with a loopback redirect", () => {
    expect(
      parseNativeStart({ redirect_uri: REDIRECT, code_challenge: RFC_CHALLENGE, code_challenge_method: "S256" }),
    ).toEqual({ kind: "native", params: { codeChallenge: RFC_CHALLENGE, redirectUri: REDIRECT } });
  });

  it("refuses plain PKCE, and a missing method", () => {
    for (const method of ["plain", undefined]) {
      const parsed = parseNativeStart({ redirect_uri: REDIRECT, code_challenge: RFC_CHALLENGE, code_challenge_method: method });
      expect(parsed.kind).toBe("invalid");
      if (parsed.kind === "invalid") expect(parsed.message).toContain("S256");
    }
  });

  it("refuses a half-formed native request instead of falling back to the cookie flow", () => {
    expect(parseNativeStart({ redirect_uri: REDIRECT }).kind).toBe("invalid");
    expect(parseNativeStart({ code_challenge: RFC_CHALLENGE, code_challenge_method: "S256" }).kind).toBe("invalid");
  });

  it("refuses a challenge that isn't a base64url SHA-256", () => {
    expect(
      parseNativeStart({ redirect_uri: REDIRECT, code_challenge: "short", code_challenge_method: "S256" }).kind,
    ).toBe("invalid");
  });
});

describe("pending native requests", () => {
  it("are stored by state hash, never the raw state, and taken exactly once", () => {
    createNativeRequest(db, "the-state", "github", { codeChallenge: RFC_CHALLENGE, redirectUri: REDIRECT });

    const stored = db.prepare("SELECT state_hash FROM relay_native_requests").all() as { state_hash: string }[];
    expect(stored).toEqual([{ state_hash: sha256Hex("the-state") }]);

    expect(takeNativeRequest(db, "the-state", "github")).toEqual({ codeChallenge: RFC_CHALLENGE, redirectUri: REDIRECT });
    expect(takeNativeRequest(db, "the-state", "github")).toBeNull();
  });

  it("aren't found under the other provider's callback", () => {
    createNativeRequest(db, "the-state", "github", { codeChallenge: RFC_CHALLENGE, redirectUri: REDIRECT });
    expect(takeNativeRequest(db, "the-state", "google")).toBeNull();
  });

  it("are dead once expired", () => {
    createNativeRequest(db, "the-state", "github", { codeChallenge: RFC_CHALLENGE, redirectUri: REDIRECT });
    db.prepare("UPDATE relay_native_requests SET expires_at = datetime('now', '-1 second')").run();
    expect(takeNativeRequest(db, "the-state", "github")).toBeNull();
  });
});

describe("auth codes", () => {
  const params = { codeChallenge: RFC_CHALLENGE, redirectUri: REDIRECT };
  const redeem = (code: string, overrides: { codeVerifier?: string; redirectUri?: string } = {}) =>
    redeemAuthCode(db, { code, codeVerifier: RFC_VERIFIER, redirectUri: REDIRECT, ...overrides });

  it("are stored hashed, expire within 60 seconds, and redeem once for the right verifier", () => {
    const code = mintAuthCode(db, userId, params);
    const row = db
      .prepare("SELECT code_hash, (julianday(expires_at) - julianday('now')) * 86400 AS ttl FROM relay_auth_codes")
      .get() as { code_hash: string; ttl: number };
    expect(row.code_hash).toBe(sha256Hex(code));
    expect(row.code_hash).not.toBe(code);
    expect(row.ttl).toBeGreaterThan(55);
    expect(row.ttl).toBeLessThanOrEqual(60);

    expect(redeem(code)).toEqual({ ok: true, relayUserId: userId });
  });

  it("refuse a reused code", () => {
    const code = mintAuthCode(db, userId, params);
    expect(redeem(code).ok).toBe(true);
    expect(redeem(code)).toEqual({ ok: false, reason: "used" });
  });

  it("refuse an expired code", () => {
    const code = mintAuthCode(db, userId, params);
    db.prepare("UPDATE relay_auth_codes SET expires_at = datetime('now', '-1 second')").run();
    expect(redeem(code)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuse a wrong verifier, and burn the code so the right one can't follow", () => {
    const code = mintAuthCode(db, userId, params);
    expect(redeem(code, { codeVerifier: "x".repeat(43) })).toEqual({ ok: false, reason: "mismatch" });
    expect(redeem(code)).toEqual({ ok: false, reason: "used" });
  });

  it("refuse a different redirect_uri, even another loopback port", () => {
    const code = mintAuthCode(db, userId, params);
    expect(redeem(code, { redirectUri: "http://127.0.0.1:53683/callback" })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuse a code that was never issued", () => {
    expect(redeem("not-a-code")).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuse a malformed verifier without spending a real code", () => {
    const code = mintAuthCode(db, userId, params);
    expect(redeem(code, { codeVerifier: "too-short" })).toEqual({ ok: false, reason: "malformed" });
    expect(redeem(code).ok).toBe(true);
  });
});
