// Test-only: a stand-in for legato.fm's signing side, so the server's
// verifier is tested against real Ed25519 signatures rather than mocks.
// Not a *.spec.ts, so `bun test` never runs it as a suite of its own. The
// relay's real signer is relay/src/signing-keys.ts; relay/src/server-token
// .spec.ts feeds its output through this server's verifier too.
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export const TEST_ISSUER = "https://auth.legato.test";

export type TestKey = { kid: string; privateKey: KeyObject; jwk: Record<string, string> };

export function makeTestKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { x } = publicKey.export({ format: "jwk" }) as { x: string };
  const kid = createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })).digest("base64url");
  return { kid, privateKey, jwk: { kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" } };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signTestToken(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT", kid: key.kid },
): string {
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const signature = sign(null, Buffer.from(signingInput), key.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function testClaims(serverId: string, nowSeconds: number, overrides: Record<string, unknown> = {}) {
  return {
    iss: TEST_ISSUER,
    sub: "42",
    aud: serverId,
    iat: nowSeconds,
    exp: nowSeconds + 600,
    jti: "test",
    scope: "access",
    email: "owner@example.com",
    email_verified: true,
    name: "Test Owner",
    ...overrides,
  };
}

// A fetch that serves a JWKS and counts every call, so a spec can prove
// the server made no contact at all.
export function jwksFetch(keys: () => TestKey[]) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ keys: keys().map((k) => k.jwk) }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}
