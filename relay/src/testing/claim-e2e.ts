// Local end-to-end for issue #237: a fresh home server showing a setup
// code, an account claiming it on this relay's claim page, the server
// picking the claim up while its /setup page checks in, the owner created
// with the claiming account linked, and a legato.fm `access` token opening
// the library. No real provider, and nothing sent to auth.legato.fm.
//
// Starts a relay on RELAY_PORT (stubbed GitHub exchange, throwaway
// RELAY_DATA_DIR, signing key from RELAY_SIGNING_KEYS) and drives a home
// server that's already running, with no owner yet and LEGATO_ID_ORIGIN
// pointed at this relay:
//
//   RELAY_SIGNING_KEYS="[$(bun scripts/generate-signing-key.ts)]" \
//   RELAY_PORT=8912 RELAY_DATA_DIR=<throwaway dir> \
//   LEGATO_SERVER=http://127.0.0.1:8902 LEGATO_DATA_DIR=<the server's data dir> \
//   LEGATO_OWNER_PASSWORD=<at least 8 characters> \
//   bun src/testing/claim-e2e.ts
//
// The server: LEGATO_ID_ORIGIN=http://127.0.0.1:8912 LEGATO_PORT=8902
// LEGATO_UPDATE_CHECK=off LEGATO_DATA_DIR=<a fresh dir> bun server/src/index.ts.
// The harness plays the /setup page from loopback, which the server lets
// see its setup code the same way it lets a page on the LAN.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { claimProof, serverIdForPublicKey } from "../../../server/src/auth/serverKey.js";
import { createSession, upsertUser } from "../accounts.js";
import { buildApp } from "../app.js";
import { DATA_DIR, PORT } from "../config.js";
import { openDb } from "../db.js";
import { openSqlite } from "../sqlite.js";

const SERVER = process.env.LEGATO_SERVER;
const SERVER_DATA_DIR = process.env.LEGATO_DATA_DIR;
const PASSWORD = process.env.LEGATO_OWNER_PASSWORD;
if (!process.env.RELAY_PORT || !process.env.RELAY_DATA_DIR || !process.env.RELAY_SIGNING_KEYS || !SERVER || !SERVER_DATA_DIR || !PASSWORD) {
  console.error("Set RELAY_PORT, RELAY_DATA_DIR, RELAY_SIGNING_KEYS, LEGATO_SERVER, LEGATO_DATA_DIR and LEGATO_OWNER_PASSWORD explicitly.");
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const db = openDb();
const relay = buildApp({
  db,
  auth: {
    config: { githubClientId: "e2e-not-a-real-client", githubClientSecret: "e2e-not-a-real-secret", callbackBaseUrl: RELAY },
    exchange: {
      github: async () => ({
        providerUserId: "e2e-237",
        email: "rowan@example.com",
        emailVerified: true,
        displayName: "Rowan",
        avatarUrl: null,
      }),
    },
  },
});
// Every request the home server makes here, to prove when it asks.
let exchanges = 0;
relay.addHook("onRequest", async (request) => {
  if (request.url === "/pair/exchange") exchanges++;
});
const asked = () => exchanges;
await relay.listen({ port: PORT, host: "127.0.0.1" });
const jwks = (await (await fetch(`${RELAY}/.well-known/jwks.json`)).json()) as { keys: { kid: string }[] };
check(jwks.keys.length > 0, "the relay publishes a signing key");
step("relay listening", `${RELAY}, data dir ${DATA_DIR}, kid ${jwks.keys[0]!.kid}`);

// 1. A fresh server: no owner, a setup code, and a QR to this relay.
const status = (await (await fetch(`${API}/auth/status`)).json()) as { ownerExists: boolean; legato: { serverId: string; issuer: string } };
check(!status.ownerExists, "the server has no owner yet (start it on a fresh LEGATO_DATA_DIR)");
check(status.legato.issuer === RELAY, `the server trusts this relay (LEGATO_ID_ORIGIN=${RELAY})`);
const serverId = status.legato.serverId;
type Setup = { code: string; claimUrl: string; claim: { state: string; account?: { id: string; name: string; email: string } } };
const setup = async () => (await (await fetch(`${API}/auth/setup`)).json()) as Setup;
await sleep(6_000);
check(asked() === 0, "nothing asks the relay before a /setup page checks in");
const shown = await setup();
check(shown.claimUrl === `${RELAY}/claim?code=${shown.code}`, `the QR opens this relay's claim page (${shown.claimUrl})`);
await sleep(7_000);
check(asked() === 1, `one check-in, one exchange, then silence (${asked()})`);
step("fresh server", `id ${serverId}, code ${shown.code}; 0 exchanges before /setup checked in, 1 after, none once it stopped`);

// 2. The phone: open the claim page, sign in, come back, claim.
const claimPath = `/claim?code=${encodeURIComponent(shown.code.toLowerCase().replace("-", ""))}`;
const signedOut = await (await fetch(`${RELAY}${claimPath}`)).text();
check(signedOut.includes('data-view="signed_out"'), "a signed-out visitor is asked to sign in");
const start = await fetch(`${RELAY}/auth/github?return_to=${encodeURIComponent(claimPath)}`, { redirect: "manual" });
const startCookies = start.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
const callback = await fetch(`${RELAY}/auth/github/callback?code=provider-code&state=${state}`, {
  redirect: "manual",
  headers: { cookie: startCookies },
});
check(
  callback.headers.get("location") === `/claim?code=${shown.code}`,
  `sign-in comes back to the claim page (${callback.headers.get("location")})`,
);
const session = callback.headers
  .getSetCookie()
  .find((c) => c.startsWith("relay_session="))!
  .split(";")[0]!;
const page = async (cookie = session) =>
  /data-view="([a-z_]+)"/.exec(await (await fetch(`${RELAY}/claim?code=${shown.code}`, { headers: { cookie } })).text())?.[1];
check((await page()) === "ready", "signed in, the page offers the claim");
const claimed = await fetch(`${RELAY}/pair/claim`, {
  method: "POST",
  headers: { cookie: session, origin: RELAY, "Content-Type": "application/json" },
  body: JSON.stringify({ code: shown.code }),
});
check(claimed.ok, `the account claims the code (${claimed.status})`);
check((await page()) === "pending", "the page waits for the server");
step("claimed on the relay's page", `Rowan, page "${await page()}"`);

// 3. Someone else can't take it over.
const other = upsertUser(db, "github", {
  providerUserId: "e2e-237-other",
  email: "sam@example.com",
  emailVerified: true,
  displayName: "Sam",
  avatarUrl: null,
});
const otherCookie = `relay_session=${createSession(db, other.id).token}`;
const taken = await fetch(`${RELAY}/pair/claim`, {
  method: "POST",
  headers: { cookie: otherCookie, origin: RELAY, "Content-Type": "application/json" },
  body: JSON.stringify({ code: shown.code }),
});
check(taken.status === 409 && (await page(otherCookie)) === "taken", "a second account is told it's already claimed");
step("a second account", `POST /pair/claim ${taken.status}, page "${await page(otherCookie)}"`);

// 4. The /setup page checks in until the server has picked the claim up.
let view = shown.claim;
for (let i = 0; i < 20 && view.state !== "claimed"; i++) {
  await sleep(1_000);
  view = (await setup()).claim;
}
check(view.state === "claimed", `the server picked the claim up (${JSON.stringify(view)})`);
check(view.account?.email === "r•••@example.com", "/setup masks the claiming account's email");
check((await page()) === "picked_up", "the claim page says the server has it");
check(
  (db.prepare("SELECT COUNT(*) AS n FROM tunnel_credentials").get() as { n: number }).n === 0,
  "no credential exists before the owner links",
);
step("picked up while /setup checked in", `${view.account!.name} (${view.account!.email}), ${asked()} exchange(s) in all`);

// 5. A code redeemed by a different key gets nothing that's this server's.
const hostileKey = generateKeyPairSync("ed25519").privateKey;
const hostilePublic = (createPublicKey(hostileKey).export({ format: "jwk" }) as { x: string }).x;
const hostile = { serverId: serverIdForPublicKey(hostilePublic), publicKey: hostilePublic, privateKey: hostileKey };
const replay = await fetch(`${RELAY}/pair/exchange`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(claimProof(hostile, { issuer: RELAY, code: shown.code, nowSeconds: Math.floor(Date.now() / 1000) })),
});
check(replay.status === 410, "the spent code can't be redeemed again, by anyone");
step("a second redemption", `${replay.status} ${((await replay.json()) as { reason: string }).reason}`);

// 6. Create the owner, choosing to link the account /setup showed.
const ownerRes = await fetch(`${API}/auth/owner`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: PASSWORD, linkAccountId: view.account!.id }),
});
const owner = (await ownerRes.json()) as { token: string; legato?: { linked: { accountId: string } | null; error?: string } };
check(
  ownerRes.status === 201 && owner.legato?.linked?.accountId === view.account!.id,
  `the owner is created and linked (${JSON.stringify(owner.legato)})`,
);
const pairs = db.prepare("SELECT relay_user_id, server_id FROM linked_servers").all();
const relayCredentials = db.prepare("SELECT token, relay_user_id, server_id FROM tunnel_credentials").all() as {
  token: string;
  relay_user_id: number;
  server_id: string;
}[];
check(pairs.length === 1 && (pairs[0] as { server_id: string }).server_id === serverId, "the relay recorded the pair for this server");
check(
  relayCredentials.length === 1 && relayCredentials[0]!.server_id === serverId,
  "the relay minted one credential, bound to this server",
);
const serverDb = openSqlite(path.join(SERVER_DATA_DIR, "legato.db"));
const stored = serverDb.prepare("SELECT origin, account_id, credential FROM tunnel_credential WHERE id = 1").get() as
  { origin: string; account_id: string; credential: string } | undefined;
serverDb.close();
check(stored?.credential === relayCredentials[0]!.token && stored.origin === RELAY, "the server stored that credential");
step(
  "owner created and linked",
  `pair ${JSON.stringify(pairs)}, credential bound to ${relayCredentials[0]!.server_id}, stored on the server`,
);

// 7. The point of it all: an access token opens the library.
const tokenRes = await fetch(`${RELAY}/auth/server-token`, {
  method: "POST",
  headers: { cookie: session, "Content-Type": "application/json" },
  body: JSON.stringify({ serverId }),
});
const access = (await tokenRes.json()) as { token: string; scope: string };
check(access.scope === "access", `legato.fm signs access for the claimed server (${access.scope})`);
const library = await fetch(`${API}/nodes?limit=5`, { headers: { Authorization: `Bearer ${access.token}` } });
const nodes = (await library.json()) as unknown[];
check(library.status === 200 && Array.isArray(nodes), `the access token opens the library (${library.status})`);
step("library request with a legato.fm access token", `GET /api/v1/nodes?limit=5 → ${library.status}, ${nodes.length} node(s)`);

await relay.close();
console.log("end-to-end passed");
