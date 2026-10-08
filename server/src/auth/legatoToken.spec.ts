import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { makeTestKey, signTestToken, testClaims, TEST_ISSUER } from "./legato-test-keys.js";
import { importEd25519Jwk, looksLikeJws, verifyLegatoToken } from "./legatoToken.js";

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000;
const key = makeTestKey();
const keys = new Map([[key.kid, importEd25519Jwk(key.jwk)!.key]]);
const options = { keys, issuer: TEST_ISSUER, audience: SERVER_ID, nowSeconds: NOW };

function reason(token: string, overrides: Partial<typeof options> = {}) {
  const result = verifyLegatoToken(token, { ...options, ...overrides });
  return result.ok ? "ok" : result.reason;
}

function b64(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("verifyLegatoToken", () => {
  it("accepts a well-formed token and returns its claims", () => {
    const result = verifyLegatoToken(signTestToken(key, testClaims(SERVER_ID, NOW)), options);
    expect(result).toEqual({
      ok: true,
      claims: {
        iss: TEST_ISSUER,
        sub: "42",
        aud: SERVER_ID,
        iat: NOW,
        exp: NOW + 600,
        scope: "access",
        jti: "test",
        email: "owner@example.com",
        emailVerified: true,
        name: "Test Owner",
      },
    });
  });

  it("refuses a tampered payload", () => {
    const [header, , signature] = signTestToken(key, testClaims(SERVER_ID, NOW)).split(".");
    const forged = b64(testClaims(SERVER_ID, NOW, { sub: "1" }));
    expect(reason(`${header}.${forged}.${signature}`)).toBe("bad_signature");
  });

  it("refuses a tampered signature", () => {
    const token = signTestToken(key, testClaims(SERVER_ID, NOW));
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const bytes = Buffer.from(signature, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    expect(reason(`${header}.${payload}.${bytes.toString("base64url")}`)).toBe("bad_signature");
    expect(reason(`${header}.${payload}.${signature.slice(0, 20)}`)).toBe("bad_signature");
  });

  it("refuses a token signed by a different key under a known kid", () => {
    const impostor = makeTestKey();
    const token = signTestToken(impostor, testClaims(SERVER_ID, NOW), { alg: "EdDSA", typ: "JWT", kid: key.kid });
    expect(reason(token)).toBe("bad_signature");
  });

  it("refuses an expired token, allowing 30 seconds of skew", () => {
    const token = signTestToken(key, testClaims(SERVER_ID, NOW - 600, { exp: NOW }));
    expect(reason(token, { nowSeconds: NOW + 29 })).toBe("ok");
    expect(reason(token, { nowSeconds: NOW + 30 })).toBe("expired");
    expect(reason(token, { nowSeconds: NOW + 3600 })).toBe("expired");
  });

  it("refuses a token issued in the future beyond the skew", () => {
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW + 30)))).toBe("ok");
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW + 31)))).toBe("not_yet_valid");
  });

  it("refuses a lifetime over 15 minutes, even correctly signed", () => {
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW, { exp: NOW + 900 })))).toBe("ok");
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW, { exp: NOW + 901 })))).toBe("lifetime_too_long");
  });

  it("refuses the wrong audience, and an array audience even if it contains this server", () => {
    expect(reason(signTestToken(key, testClaims("ffffffffffffffffffffffffffffffff", NOW)))).toBe("wrong_audience");
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW, { aud: [SERVER_ID] })))).toBe("wrong_audience");
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW, { aud: undefined })))).toBe("wrong_audience");
  });

  it("refuses the wrong issuer", () => {
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW, { iss: "https://evil.example" })))).toBe("wrong_issuer");
  });

  it("refuses an unknown kid, and a missing one", () => {
    const stranger = makeTestKey();
    expect(reason(signTestToken(stranger, testClaims(SERVER_ID, NOW)))).toBe("unknown_key");
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW), { alg: "EdDSA" }))).toBe("bad_header");
  });

  it("pins the algorithm: alg none, HS256 with the public key as secret, and crit are refused", () => {
    const claims = testClaims(SERVER_ID, NOW);
    const none = `${b64({ alg: "none", kid: key.kid })}.${b64(claims)}.`;
    expect(reason(none)).toBe("malformed");
    expect(reason(`${none}AAAA`)).toBe("bad_header");

    const hsInput = `${b64({ alg: "HS256", typ: "JWT", kid: key.kid })}.${b64(claims)}`;
    const hsSig = createHmac("sha256", key.jwk.x!).update(hsInput).digest("base64url");
    expect(reason(`${hsInput}.${hsSig}`)).toBe("bad_header");

    expect(reason(signTestToken(key, claims, { alg: "EdDSA", kid: key.kid, crit: ["exp"] }))).toBe("bad_header");
    expect(reason(signTestToken(key, claims, { alg: "EdDSA", kid: key.kid, typ: "at+jwt" }))).toBe("bad_header");
  });

  it("refuses missing or malformed claims", () => {
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW, { sub: "" })))).toBe("bad_claims");
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW, { exp: "soon" })))).toBe("bad_claims");
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW, { scope: "admin" })))).toBe("bad_claims");
    expect(reason(signTestToken(key, testClaims(SERVER_ID, NOW, { scope: undefined })))).toBe("bad_claims");
  });

  it("refuses anything that isn't three base64url segments", () => {
    expect(reason("")).toBe("malformed");
    expect(reason("a.b")).toBe("malformed");
    expect(reason("a.b.c.d")).toBe("malformed");
    expect(reason(`${signTestToken(key, testClaims(SERVER_ID, NOW))}=`)).toBe("malformed");
    expect(reason("bm90IGpzb24.e30.AAAA")).toBe("malformed");
  });

  it("reads email_verified as true only when it is literally true", () => {
    const result = verifyLegatoToken(signTestToken(key, testClaims(SERVER_ID, NOW, { email_verified: "true" })), options);
    expect(result.ok && result.claims.emailVerified).toBe(false);
  });
});

describe("importEd25519Jwk", () => {
  it("takes only OKP/Ed25519 signing keys", () => {
    expect(importEd25519Jwk(key.jwk)?.kid).toBe(key.kid);
    expect(importEd25519Jwk({ ...key.jwk, crv: "X25519" })).toBeNull();
    expect(importEd25519Jwk({ ...key.jwk, kty: "RSA" })).toBeNull();
    expect(importEd25519Jwk({ ...key.jwk, alg: "RS256" })).toBeNull();
    expect(importEd25519Jwk({ ...key.jwk, use: "enc" })).toBeNull();
    expect(importEd25519Jwk({ ...key.jwk, kid: undefined })).toBeNull();
    expect(importEd25519Jwk({ ...key.jwk, x: "short" })).toBeNull();
    expect(importEd25519Jwk(null)).toBeNull();
  });
});

describe("looksLikeJws", () => {
  it("tells a JWS from a session token", () => {
    expect(looksLikeJws(signTestToken(key, testClaims(SERVER_ID, NOW)))).toBe(true);
    expect(looksLikeJws("Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE")).toBe(false);
  });
});
