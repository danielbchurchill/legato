// Local end-to-end for issue #117's legato.fm path on the connect screen,
// against a real home server and a relay on this machine, with no real
// provider and nothing sent to auth.legato.fm. It runs the client's own code
// (src/connect/), not a copy of it.
//
//   RELAY_SIGNING_KEYS="[$(bun scripts/generate-signing-key.ts)]" \
//   RELAY_PORT=8913 RELAY_DATA_DIR=<throwaway dir> \
//   LEGATO_SERVER=http://127.0.0.1:8903 LEGATO_OWNER_PASSWORD=<at least 12 characters> \
//   bun src/testing/connect-e2e.ts
//
// The server: LEGATO_ID_ORIGIN=http://127.0.0.1:8913 LEGATO_PORT=8903
// LEGATO_DATA_DIR=<throwaway dir> bun server/src/index.ts.
//
// It checks: the account's servers are listed (GET /linked-servers, with
// CORS for the desktop webview); the client signs in to the real server
// with legato.fm and the session opens the library and media; a token works
// once; a server with a different key claiming the same id is refused, and
// neither it nor legato.fm is asked for or sent a token; unlinking ends the
// legato.fm session.
import { createHash, randomBytes } from "node:crypto";
import { buildApp } from "../app.js";
import { DATA_DIR, PORT } from "../config.js";
import { openDb } from "../db.js";
import { verifyServerIdentity } from "../../../src/connect/identity.js";
import { signInWithLegato } from "../../../src/connect/legatoSignIn.js";
import { fakeServerKey } from "../../../src/connect/testServerKey.js";

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
        providerUserId: "e2e-117",
        email: "rowan@example.com",
        emailVerified: true,
        displayName: "Rowan",
        avatarUrl: null,
      }),
    },
  },
});
await relay.listen({ port: PORT, host: "127.0.0.1" });
step("relay listening", `${RELAY}, data dir ${DATA_DIR}`);

// 1. Sign in to legato.fm the way the desktop app does (issue #215).
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
const signedIn = (await (
  await fetch(`${RELAY}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
  })
).json()) as { token: string; user: { id: number; displayName: string } };
check(signedIn.token, "the app redeems the code for a legato.fm session");
const relayToken = signedIn.token;
const legato = { Authorization: `Bearer ${relayToken}`, "Content-Type": "application/json" };
step("signed in to legato.fm", `${signedIn.user.displayName}, account ${signedIn.user.id}`);
// The connect screen prints this session for its screenshots harness.
if (process.env.PRINT_RELAY_SESSION) console.log(`relay session ${relayToken}`);

// 2. The owner links the home server.
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
const status = (await (await fetch(`${API}/auth/status`)).json()) as { legato: { serverId: string; publicKey: string; issuer: string } };
check(status.legato.issuer === RELAY, `the server trusts this relay (LEGATO_ID_ORIGIN=${RELAY})`);
const serverId = status.legato.serverId;
step("home server", `${SERVER}, id ${serverId}, public key ${status.legato.publicKey}`);

const serverToken = async (scope?: "link") => {
  const res = await fetch(`${RELAY}/auth/server-token`, { method: "POST", headers: legato, body: JSON.stringify({ serverId, scope }) });
  return (await res.json()) as { token: string; scope: "access" | "link" };
};
const linkRes = await fetch(`${API}/auth/legato/link`, {
  method: "POST",
  headers: owner,
  body: JSON.stringify({ token: (await serverToken("link")).token }),
});
check(linkRes.status === 200, `the owner links the server (${linkRes.status})`);

// 3. "Your servers": the account's own list, readable from the desktop webview.
const listed = await fetch(`${RELAY}/linked-servers`, { headers: { Authorization: legato.Authorization, Origin: "tauri://localhost" } });
const { servers } = (await listed.json()) as { servers: { serverId: string; linkedAt: string }[] };
check(listed.headers.get("access-control-allow-origin") === "tauri://localhost", "GET /linked-servers allows the desktop webview");
check(servers.length === 1 && servers[0]!.serverId === serverId, "the account's servers list the linked server");
step("your servers", JSON.stringify(servers));

// 4. The identity check against the real server.
const identity = await verifyServerIdentity(SERVER, serverId);
check(identity.ok, "the real server proves it holds its id's key");
step("identity proof from the real server", `hash(${identity.publicKey}) == ${serverId}, signature verifies`);

// 5. The client signs in with legato.fm, with its own code.
const calls: string[] = [];
const recording = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push(String(input));
  return fetch(input, init);
}) as typeof fetch;
const signIn = await signInWithLegato(SERVER, serverId, { fetchImpl: recording, relayOrigin: RELAY, relayToken });
check(signIn.ok, `the client signs in to the server with legato.fm (${JSON.stringify(signIn)})`);
const session = signIn.session;
check(session.legato?.serverId === serverId, "the session is marked as legato.fm's");
step("signed in with legato.fm", calls.map((c) => new URL(c).pathname).join(" → "));
const lifetimeHours = (Date.parse(session.legato!.expiresAt) - Date.now()) / 3_600_000;
check(lifetimeHours > 11.9 && lifetimeHours <= 12, `a fixed 12-hour session (${lifetimeHours.toFixed(2)} h)`);
const nodes = await fetch(`${API}/nodes?limit=5`, { headers: { Authorization: `Bearer ${session.token}` } });
check(nodes.status === 200, "the legato.fm session opens the library");
const media = await fetch(`${API}/nodes?limit=1&t=${encodeURIComponent(session.mediaTicket)}`);
check(media.status === 200, "its media ticket reads");
step("library and media", `GET /nodes → ${nodes.status}, ?t= ticket → ${media.status}, expires ${session.legato!.expiresAt}`);

// 6. An access token works once.
const access = await serverToken();
check(access.scope === "access", "a linked server gets an access token");
const exchange = () => fetch(`${API}/auth/legato/session`, { method: "POST", headers: { Authorization: `Bearer ${access.token}` } });
check((await exchange()).status === 200, "the first exchange works");
const again = await exchange();
check(again.status === 409, "a second exchange of the same token is refused");
step("a token works once", `second exchange ${again.status} ${((await again.json()) as { reason: string }).reason}`);
const withSession = await fetch(`${API}/auth/legato/session`, { method: "POST", headers: { Authorization: `Bearer ${session.token}` } });
check(withSession.status === 403, "a session can't mint a session");
step("a session can't mint a session", `${withSession.status} ${((await withSession.json()) as { reason: string }).reason}`);

// 7. A spoofer on the LAN: a server with a different key that answers with
// this server's id. It signs correctly, with its own key.
const spooferKey = fakeServerKey();
const spooferSaw: { path: string; authorization: string | null }[] = [];
const spoofer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    spooferSaw.push({ path: url.pathname, authorization: request.headers.get("authorization") });
    if (url.pathname === "/api/v1/auth/identity") {
      const { nonce } = (await request.json()) as { nonce: string };
      return Response.json(spooferKey.prove(nonce, serverId));
    }
    if (url.pathname === "/api/v1/auth/status") return Response.json({ legato: { serverId, publicKey: spooferKey.publicKey } });
    return Response.json({ token: "x", mediaTicket: "y", expiresAt: new Date().toISOString() });
  },
});
const spooferOrigin = `http://127.0.0.1:${spoofer.port}`;
calls.length = 0;
const spoofed = await signInWithLegato(spooferOrigin, serverId, { fetchImpl: recording, relayOrigin: RELAY, relayToken });
check(!spoofed.ok && spoofed.failure.step === "identity", `the spoofer is refused (${JSON.stringify(spoofed)})`);
check(!calls.some((c) => c.startsWith(RELAY)), "legato.fm was never asked for a token for it");
check(
  spooferSaw.every((r) => r.authorization === null) && !spooferSaw.some((r) => r.path.endsWith("/legato/session")),
  "the spoofer received no token",
);
step(
  "a server with a different key claiming this id",
  `${JSON.stringify(spoofed.ok ? null : spoofed.failure)}; requests: ${calls.map((c) => new URL(c).pathname).join(", ")}; spoofer saw ${JSON.stringify(spooferSaw)}`,
);
spoofer.stop(true);

// 8. Unlinking on the server ends the legato.fm session at once.
const unlinked = await fetch(`${API}/auth/legato/link`, { method: "DELETE", headers: { Authorization: owner.Authorization } });
check(unlinked.status === 200, "the owner unlinks the account");
const after = await fetch(`${API}/nodes?limit=1`, { headers: { Authorization: `Bearer ${session.token}` } });
check(after.status === 401, "the legato.fm session no longer opens the library");
const ownerStill = await fetch(`${API}/nodes?limit=1`, { headers: { Authorization: owner.Authorization } });
check(ownerStill.status === 200, "the owner's password session still does");
step("unlinked on the server", `legato.fm session → ${after.status}, password session → ${ownerStill.status}`);

if (process.env.KEEP_RELAY) {
  // Relink, and keep the relay up for the connect screen's screenshots.
  const relink = await fetch(`${API}/auth/legato/link`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ token: (await serverToken("link")).token }),
  });
  check(relink.status === 200, "relinked for the screenshots");
  console.log(`relay session ${relayToken}`);
  console.log("end-to-end passed; relay still up (KEEP_RELAY)");
} else {
  await relay.close();
  console.log("end-to-end passed");
}
