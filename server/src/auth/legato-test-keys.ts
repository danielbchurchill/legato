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

// A fetch standing in for legato.fm. It serves the JWKS, takes the link and
// unlink reports (issue #231) and keeps every call, so a spec can prove both
// what the server sent and that it sent nothing at all. `answer` decides the
// reply to a report: a Response, or an Error to play an unreachable service.
export type LegatoReport = { url: string; body: Record<string, unknown> };

export function fakeLegatoFetch(
  keys: () => TestKey[],
  answer: (report: LegatoReport) => Response | Error = () => Response.json({ ok: true }),
) {
  const calls: string[] = [];
  const reports: LegatoReport[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    if (init?.method === "POST") {
      const report = { url: String(input), body: JSON.parse(String(init.body)) as Record<string, unknown> };
      reports.push(report);
      const reply = answer(report);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    return new Response(JSON.stringify({ keys: keys().map((k) => k.jwk) }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls, reports };
}
