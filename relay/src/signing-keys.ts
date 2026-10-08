import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import type { RelayUserRow } from "./accounts.js";

// legato.fm as the identity provider (issue #114): the keys this service
// signs home-server tokens with, and the tokens themselves. Home servers
// verify them against GET /.well-known/jwks.json (server/src/auth/
// legatoToken.ts is the other half, and the rules it holds tokens to).
//
// The keys live in the RELAY_SIGNING_KEYS Fly secret, never on the volume:
// the volume holds relay.db and its snapshots, and a leaked snapshot
// shouldn't also leak the key every home server trusts. The secret is a
// JSON array of { "privateKey": "<PKCS#8 PEM>" }, which
// scripts/generate-signing-key.ts prints. The first entry signs; every
// entry is published. Rotating:
//   1. Append a new key second. It's published, not yet signing.
//   2. Wait over a day, so every linked server's daily refresh has it.
//   3. Move it first. It signs from now on.
//   4. After 15 minutes every token the old key signed has expired.
//      Remove it.
// A server that misses step 2 still recovers: an unknown kid makes it
// refetch the key set in the background.

// Ten minutes, under the 15-minute ceiling servers enforce, so a device's
// clock a few minutes off doesn't turn a fresh token into a refused one.
export const SERVER_TOKEN_TTL_SECONDS = 10 * 60;

// Matches server_identity.server_id (server migrations 0032 and 0037): 128
// bits as 32 lowercase hex characters, the start of the SHA-256 of the
// server's public key (linked-servers.ts).
export const SERVER_ID_PATTERN = /^[0-9a-f]{32}$/;

export type PublicJwk = { kty: "OKP"; crv: "Ed25519"; x: string; kid: string; alg: "EdDSA"; use: "sig" };

export type SigningKeys = {
  signing: { kid: string; privateKey: KeyObject };
  published: PublicJwk[];
  // Every published key by kid, for checking a token this service signed
  // when a home server hands one back (linked-servers.ts).
  verifying: ReadonlyMap<string, KeyObject>;
};

// RFC 7638 thumbprint: SHA-256 over the required members in lexical
// order. Derived from the key itself, so there's no kid to configure or
// get out of step.
export function jwkThumbprint(x: string): string {
  return createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })).digest("base64url");
}

export function publicJwk(privateKey: KeyObject): PublicJwk {
  const { x } = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return { kty: "OKP", crv: "Ed25519", x, kid: jwkThumbprint(x), alg: "EdDSA", use: "sig" };
}

// Throws with a message naming what's wrong, never the key material.
// routes/auth.ts turns a throw into "signing off" plus a log line, so a
// bad secret can't stop sign-in itself from working.
export function parseSigningKeys(raw: string | undefined): SigningKeys | null {
  if (!raw?.trim()) return null;
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error('RELAY_SIGNING_KEYS isn\'t valid JSON. It should be an array like [{"privateKey":"-----BEGIN PRIVATE KEY-----\\n…"}].');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("RELAY_SIGNING_KEYS must be a non-empty JSON array of { privateKey } entries.");
  }
  const keys = entries.map((entry, index) => {
    const pem = (entry as { privateKey?: unknown } | null)?.privateKey;
    if (typeof pem !== "string") throw new Error(`RELAY_SIGNING_KEYS entry ${index} has no privateKey string.`);
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(pem);
    } catch {
      throw new Error(`RELAY_SIGNING_KEYS entry ${index} isn't a readable PKCS#8 PEM private key.`);
    }
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`RELAY_SIGNING_KEYS entry ${index} is a ${privateKey.asymmetricKeyType} key; only Ed25519 is used.`);
    }
    return privateKey;
  });
  const published = keys.map(publicJwk);
  const verifying = new Map(keys.map((key, index) => [published[index]!.kid, createPublicKey(key)]));
  return { signing: { kid: published[0]!.kid, privateKey: keys[0]! }, published, verifying };
}

export type ServerTokenScope = "access" | "link";

export type IssuedServerToken = { token: string; expiresAt: Date; scope: ServerTokenScope };

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// tunnel marks a `link` token handed to a server that redeemed a claimed
// code (issue #237, routes/pair.ts). Reporting that link also mints the
// server's tunnel credential (linked-servers.ts). Only this service reads
// it; home servers ignore claims they don't know.
export function signServerToken(
  keys: SigningKeys,
  input: { issuer: string; user: RelayUserRow; serverId: string; scope: ServerTokenScope; tunnel?: boolean; nowSeconds?: number },
): IssuedServerToken {
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + SERVER_TOKEN_TTL_SECONDS;
  const header = { alg: "EdDSA", typ: "JWT", kid: keys.signing.kid };
  const claims = {
    iss: input.issuer,
    sub: String(input.user.id),
    aud: input.serverId,
    iat,
    exp,
    // Correlates a token across logs on both sides. Nothing stores it.
    jti: randomBytes(16).toString("base64url"),
    scope: input.scope,
    email: input.user.email,
    email_verified: input.user.email !== null && input.user.email_verified === 1,
    name: input.user.display_name,
    ...(input.tunnel ? { tunnel: true } : {}),
  };
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const signature = sign(null, Buffer.from(signingInput), keys.signing.privateKey).toString("base64url");
  return { token: `${signingInput}.${signature}`, expiresAt: new Date(exp * 1000), scope: input.scope };
}

export type IssuedClaims = { sub: string; aud: string; scope: ServerTokenScope; jti: string; exp: number; tunnel: boolean };

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Reads back a token this service signed, when a home server returns one as
// part of a proof (issue #231). The checks a home server makes on the way in
// (server/src/auth/legatoToken.ts) are mostly beside the point here: this is
// the issuer, so a token is good if one of its own published keys signed it,
// for this issuer, and it hasn't expired. Null for anything else; the caller
// only needs to know it can't be used.
export function verifyIssuedToken(
  keys: SigningKeys,
  token: string,
  input: { issuer: string; nowSeconds?: number },
): IssuedClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeSegment(headerPart);
  if (header?.alg !== "EdDSA" || typeof header.kid !== "string") return null;
  const key = keys.verifying.get(header.kid);
  if (!key) return null;
  const signature = Buffer.from(signaturePart, "base64url");
  if (signature.length !== 64 || !verify(null, Buffer.from(`${headerPart}.${payloadPart}`), key, signature)) return null;

  const claims = decodeSegment(payloadPart);
  if (!claims) return null;
  const { iss, sub, aud, scope, jti, exp, tunnel } = claims;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (iss !== input.issuer || typeof exp !== "number" || exp <= now) return null;
  if (typeof sub !== "string" || typeof aud !== "string" || !SERVER_ID_PATTERN.test(aud)) return null;
  if ((scope !== "access" && scope !== "link") || typeof jti !== "string" || !jti) return null;
  return { sub, aud, scope, jti, exp, tunnel: tunnel === true };
}
