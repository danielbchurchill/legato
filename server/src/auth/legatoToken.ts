import { createPublicKey, verify, type KeyObject } from "node:crypto";

// Verifying a legato.fm token (issue #114, plan 02's Risks). legato.fm
// signs a compact JWS with Ed25519; this server checks it against the
// public keys it cached (auth/legatoIdentity.ts). Hand-rolled on
// node:crypto rather than a JWT library, the same call the OAuth code in
// routes/auth.ts makes: the whole format is three base64url segments, and
// every check below is one a library would make configurable, which is
// exactly what this file must not be.
//
// Security-critical, so it accepts one shape and refuses everything else:
//   - alg pinned to EdDSA, read from the header only to refuse anything
//     else. No `none`, and no HS256 with the public key as the HMAC secret.
//   - kid required and already cached. An unknown kid is refused, never
//     fetched mid-request.
//   - iss is the configured origin; aud is a single string equal to this
//     server's id. An array aud is refused rather than searched.
//   - exp and iat checked with 30 seconds of skew, and a lifetime over 15
//     minutes is refused even when the signature is good.

export const CLOCK_SKEW_SECONDS = 30;
export const MAX_LIFETIME_SECONDS = 15 * 60;

// "access" opens this server's library. "link" only proves who someone is,
// for POST /auth/legato/link. legato.fm signs "access" only for a server
// that account has linked, which it records when this server reports the
// link, signed with its identity key (issue #231, auth/serverKey.ts).
export type TokenScope = "access" | "link";

export type LegatoClaims = {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  scope: TokenScope;
  // legato.fm gives every token a random jti. Only POST /auth/legato/session
  // reads it, to take each access token once (issue #117); everything else
  // accepts a token without one, as before.
  jti: string | null;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

export type VerifyFailure =
  | "malformed"
  | "bad_header"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "lifetime_too_long"
  | "bad_claims";

export type VerifyResult = { ok: true; claims: LegatoClaims } | { ok: false; reason: VerifyFailure };

export type VerifyOptions = {
  keys: ReadonlyMap<string, KeyObject>;
  issuer: string;
  audience: string;
  nowSeconds?: number;
};

const SEGMENT = "[A-Za-z0-9_-]+";
const JWS_PATTERN = new RegExp(`^${SEGMENT}\\.${SEGMENT}\\.${SEGMENT}$`);

// Session tokens (auth/sessions.ts) are a single base64url segment, so a
// bearer with two dots can only be a JWS. gate.ts routes on this.
export function looksLikeJws(token: string): boolean {
  return JWS_PATTERN.test(token);
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// An Ed25519 public key from one JWKS entry, or null for anything else.
// Only OKP/Ed25519 is ever turned into a key, so an RSA or EC entry in the
// set can't be picked for verification by naming its kid.
export function importEd25519Jwk(jwk: unknown): { kid: string; key: KeyObject } | null {
  if (!jwk || typeof jwk !== "object") return null;
  const { kty, crv, x, kid, alg, use } = jwk as Record<string, unknown>;
  if (kty !== "OKP" || crv !== "Ed25519") return null;
  if (typeof x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(x)) return null;
  if (typeof kid !== "string" || !kid) return null;
  if (alg !== undefined && alg !== "EdDSA") return null;
  if (use !== undefined && use !== "sig") return null;
  try {
    return { kid, key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }) };
  } catch {
    return null;
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function verifyLegatoToken(token: string, options: VerifyOptions): VerifyResult {
  if (!looksLikeJws(token)) return { ok: false, reason: "malformed" };
  const [headerPart, payloadPart, signaturePart] = token.split(".") as [string, string, string];

  const header = decodeJson(headerPart);
  if (!header) return { ok: false, reason: "malformed" };
  // `crit` names extensions a verifier must understand to accept the
  // token. This one understands none, so any `crit` at all is a refusal.
  if (header.alg !== "EdDSA" || (header.typ !== undefined && header.typ !== "JWT") || header.crit !== undefined) {
    return { ok: false, reason: "bad_header" };
  }
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "bad_header" };
  const key = options.keys.get(header.kid);
  if (!key) return { ok: false, reason: "unknown_key" };

  const signature = Buffer.from(signaturePart, "base64url");
  // An Ed25519 signature is always 64 bytes. Checked first so a truncated
  // one is a clean refusal rather than whatever verify() makes of it.
  if (signature.length !== 64) return { ok: false, reason: "bad_signature" };
  const signed = Buffer.from(`${headerPart}.${payloadPart}`, "ascii");
  if (!verify(null, signed, key, signature)) return { ok: false, reason: "bad_signature" };

  // Nothing in the payload is read until the signature holds.
  const payload = decodeJson(payloadPart);
  if (!payload) return { ok: false, reason: "malformed" };
  const { iss, sub, aud, iat, exp, scope, jti, email, email_verified, name } = payload;

  if (iss !== options.issuer) return { ok: false, reason: "wrong_issuer" };
  if (typeof aud !== "string" || aud !== options.audience) return { ok: false, reason: "wrong_audience" };
  if (!isInteger(iat) || !isInteger(exp)) return { ok: false, reason: "bad_claims" };
  if (exp - iat > MAX_LIFETIME_SECONDS) return { ok: false, reason: "lifetime_too_long" };

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now >= exp + CLOCK_SKEW_SECONDS) return { ok: false, reason: "expired" };
  if (iat > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: "not_yet_valid" };

  if (typeof sub !== "string" || !sub) return { ok: false, reason: "bad_claims" };
  if (scope !== "access" && scope !== "link") return { ok: false, reason: "bad_claims" };

  return {
    ok: true,
    claims: {
      iss,
      sub,
      aud,
      iat,
      exp,
      scope,
      jti: typeof jti === "string" && jti ? jti : null,
      email: typeof email === "string" && email ? email : null,
      emailVerified: email_verified === true,
      name: typeof name === "string" && name ? name : null,
    },
  };
}

// What a client is told for each refusal. Specific enough to debug from
// ("your clock is off", "wrong server"), never echoing the token back.
export const VERIFY_FAILURE_MESSAGES: Record<VerifyFailure, string> = {
  malformed: "That legato.fm token isn't a well-formed signed token.",
  bad_header: "That legato.fm token uses a signing method this server doesn't accept.",
  unknown_key:
    "That legato.fm token was signed with a key this server doesn't have yet. Try again in a minute; the server fetches new keys in the background.",
  bad_signature: "That legato.fm token's signature doesn't match. It was altered, or it didn't come from legato.fm.",
  wrong_issuer: "That token wasn't issued by the legato.fm service this server trusts.",
  wrong_audience: "That legato.fm token was issued for a different server.",
  expired: "That legato.fm token has expired. Get a fresh one from legato.fm.",
  not_yet_valid: "That legato.fm token isn't valid yet. Check this device's clock and the server's.",
  lifetime_too_long: "That legato.fm token lasts longer than the 15 minutes this server accepts.",
  bad_claims: "That legato.fm token is missing something this server needs.",
};
