// Local end-to-end for issue #231: sign-in → token → library request,
// against a real home server and a relay on this machine, with no real
// provider and nothing sent to auth.legato.fm.
//
// Starts a relay on RELAY_PORT (stubbed GitHub exchange, throwaway
// RELAY_DATA_DIR, signing key from RELAY_SIGNING_KEYS), signs in the way the
// desktop app does, and drives a home server that's already running with
// LEGATO_ID_ORIGIN pointed at this relay: link it, open its library with an
// `access` token, then unlink, relink and revoke, checking which scope
// legato.fm signs at every step.
//
//   RELAY_SIGNING_KEYS="[$(bun scripts/generate-signing-key.ts)]" \
//   RELAY_PORT=8912 RELAY_DATA_DIR=<throwaway dir> \
//   LEGATO_SERVER=http://127.0.0.1:8902 LEGATO_OWNER_PASSWORD=<at least 12 characters> \
//   bun src/testing/linked-server-e2e.ts
//
// The server: LEGATO_ID_ORIGIN=http://127.0.0.1:8912 LEGATO_PORT=8902
// LEGATO_DATA_DIR=<throwaway dir> bun server/src/index.ts. With no owner
// yet, this creates one from loopback with LEGATO_OWNER_PASSWORD; with one,
// it signs in with it.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { buildApp } from "../app.js";
import { DATA_DIR, PORT } from "../config.js";
import { openDb } from "../db.js";

const SERVER = process.env.LEGATO_SERVER;
const PASSWORD = process.env.LEGATO_OWNER_PASSWORD;
if (!process.env.RELAY_PORT || !process.env.RELAY_DATA_DIR || !process.env.RELAY_SIGNING_KEYS || !SERVER || !PASSWORD) {
  console.error("Set RELAY_PORT, RELAY_DATA_DIR, RELAY_SIGNING_KEYS, LEGATO_SERVER and LEGATO_OWNER_PASSWORD explicitly.");
  process.exit(2);
}

const RELAY = `http://127.0.0.1:${PORT}`;
const API = `${SERVER}/api/v1`;

const step = (label: string, detail = "") => console.log(`ok  ${label}${detail ? `  ${detail}` : ""}`);
function check(cond: unknown, label: string): asserts cond {
  if (!cond) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
}

const db = openDb();
const relay = buildApp({
  db,
  auth: {
    config: { githubClientId: "e2e-not-a-real-client", githubClientSecret: "e2e-not-a-real-secret", callbackBaseUrl: RELAY },
    exchange: {
      github: async () => ({
        providerUserId: "e2e-231",
        email: "rowan@example.com",
        emailVerified: true,
        displayName: "Rowan",
        avatarUrl: null,
      }),
    },
  },
});
await relay.listen({ port: PORT, host: "127.0.0.1" });
const jwks = (await (await fetch(`${RELAY}/.well-known/jwks.json`)).json()) as { keys: { kid: string }[] };
check(jwks.keys.length > 0, "the relay publishes a signing key");
step("relay listening", `${RELAY}, data dir ${DATA_DIR}, kid ${jwks.keys[0]!.kid}`);

// 1. Sign in to legato.fm the way the desktop app does (issue #215): PKCE,
// a loopback redirect_uri, and the one-time code redeemed for a bearer.
// Nothing listens on the loopback; the code is read off the 302.
const verifier = randomBytes(32).toString("base64url");
const redirectUri = "http://127.0.0.1:53999/callback";
const start = await fetch(
  `${RELAY}/auth/github?${new URLSearchParams({
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  })}`,
  { redirect: "manual" },
);
const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
const callback = await fetch(`${RELAY}/auth/github/callback?code=provider-code&state=${encodeURIComponent(state)}`, {
  redirect: "manual",
  headers: { cookie: (start.headers.get("set-cookie") ?? "").split(";")[0]! },
});
const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code");
check(code, "the provider callback hands the app a code");
const signedIn = (await (
  await fetch(`${RELAY}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
  })
).json()) as { token: string; user: { id: number; displayName: string } };
check(signedIn.token, "the app redeems the code for a legato.fm session");
const legato = { Authorization: `Bearer ${signedIn.token}`, "Content-Type": "application/json" };
step("signed in to legato.fm", `${signedIn.user.displayName}, account ${signedIn.user.id}`);

// 2. The owner's own session on the home server.
let ownerRes = await fetch(`${API}/auth/owner`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
if (ownerRes.status === 409) {
  ownerRes = await fetch(`${API}/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
}
check(ownerRes.ok, `the owner has a session on the server (${ownerRes.status})`);
const owner = { Authorization: `Bearer ${((await ownerRes.json()) as { token: string }).token}`, "Content-Type": "application/json" };
const status = (await (await fetch(`${API}/auth/status`)).json()) as { legato: { serverId: string; issuer: string } };
check(status.legato.issuer === RELAY, `the server trusts this relay (LEGATO_ID_ORIGIN=${RELAY})`);
const serverId = status.legato.serverId;
step("home server", `${SERVER}, id ${serverId}`);

const serverToken = async (scope?: "link") => {
  const res = await fetch(`${RELAY}/auth/server-token`, { method: "POST", headers: legato, body: JSON.stringify({ serverId, scope }) });
  return (await res.json()) as { token: string; scope: "access" | "link" };
};
const library = (token: string) => fetch(`${API}/nodes?limit=5`, { headers: { Authorization: `Bearer ${token}` } });
const pairs = () => db.prepare("SELECT relay_user_id, server_id FROM linked_servers").all();

// 3. Unlinked: legato.fm signs link only, and that opens nothing.
const before = await serverToken();
check(before.scope === "link", "an id the account never linked gets a link token");
const refused = await library(before.token);
check(refused.status === 403, "a link token can't open the library");
step("before linking", `scope ${before.scope}, library ${refused.status} ${((await refused.json()) as { reason: string }).reason}`);

// 4. Link. The server verifies the token, then reports it to this relay,
// signed with its identity key.
const link = async () => {
  const { token } = await serverToken("link");
  return fetch(`${API}/auth/legato/link`, { method: "POST", headers: owner, body: JSON.stringify({ token }) });
};
const linked = await link();
check(linked.status === 200, `the owner links the server (${linked.status} ${await linked.clone().text()})`);
check(pairs().length === 1, "the relay recorded the pair");
step("linked", JSON.stringify(pairs()));

// 5. The point of it all: an access token opens the library.
const access = await serverToken();
check(access.scope === "access", "a linked server gets an access token");
const opened = await library(access.token);
const nodes = (await opened.json()) as unknown[];
check(opened.status === 200 && Array.isArray(nodes), "the access token opens the library");
step("library request with a legato.fm access token", `GET /api/v1/nodes?limit=5 → ${opened.status}, ${nodes.length} node(s)`);

// 6. Another server that claims this id can't prove it: it has no key that
// hashes to it.
const hostile = generateKeyPairSync("ed25519").privateKey;
const stolen = await serverToken("link");
const forged = await fetch(`${RELAY}/linked-servers`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    publicKey: (createPublicKey(hostile).export({ format: "jwk" }) as { x: string }).x,
    linkToken: stolen.token,
    signature: sign(null, Buffer.from(`legato.fm link proof\n${stolen.token}`), hostile).toString("base64url"),
  }),
});
check(forged.status === 403, "a different server's proof for this id is refused");
step("a hostile server's proof", `${forged.status} ${((await forged.json()) as { reason: string }).reason}`);

// 7. Unlink on the server: the relay is told and stops signing access.
const unlinked = (await (
  await fetch(`${API}/auth/legato/link`, { method: "DELETE", headers: { Authorization: owner.Authorization } })
).json()) as {
  legatoNotified: boolean;
};
check(unlinked.legatoNotified === true, "the server told legato.fm about the unlink");
check((await serverToken()).scope === "link", "after unlinking, legato.fm signs link again");
check((await library(access.token)).status === 403, "the earlier access token no longer opens the library");
step("unlinked on the server", `pairs ${JSON.stringify(pairs())}`);

// 8. Relink, then revoke from the account's side.
check((await link()).status === 200 && (await serverToken()).scope === "access", "relinking brings access back");
const revoked = await fetch(`${RELAY}/linked-servers/${serverId}`, { method: "DELETE", headers: { Authorization: legato.Authorization } });
check(((await revoked.json()) as { unlinked: boolean }).unlinked, "the account revokes the server on legato.fm");
check((await serverToken()).scope === "link", "after revoking, legato.fm signs link again");
step("relinked, then revoked on legato.fm", `pairs ${JSON.stringify(pairs())}`);

await relay.close();
console.log("end-to-end passed");
