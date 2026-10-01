// Local end-to-end for issue #215's desktop sign-in, with no real provider.
//
// Starts a real relay on RELAY_PORT (stubbed provider exchange, throwaway
// RELAY_DATA_DIR), then plays the desktop app over real HTTP: a one-shot
// loopback listener on 127.0.0.1:0, a PKCE pair, the browser's trip through
// /auth/github and back through the provider callback, the 302 to the
// listener, and the redemption at /auth/token. Then it checks the token
// works on /auth/me, can't be redeemed twice, and dies on /auth/logout.
//
//   RELAY_PORT=8921 RELAY_DATA_DIR=$(mktemp -d) bun src/testing/native-sign-in-e2e.ts
//
// The fake client ID below is never sent anywhere: the script stops at the
// provider's authorize URL instead of following it, and calls the relay's
// callback itself the way GitHub would.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../app.js";
import { DATA_DIR, PORT } from "../config.js";
import { openDb } from "../db.js";

if (!process.env.RELAY_PORT || !process.env.RELAY_DATA_DIR) {
  console.error("Set RELAY_PORT and RELAY_DATA_DIR explicitly, e.g. RELAY_PORT=8921 RELAY_DATA_DIR=$(mktemp -d)");
  process.exit(2);
}

const RELAY = `http://127.0.0.1:${PORT}`;
const APP_ORIGIN = "tauri://localhost";

const b64url = (buf: Buffer) => buf.toString("base64url");
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
    config: {
      githubClientId: "e2e-not-a-real-client",
      githubClientSecret: "e2e-not-a-real-secret",
      callbackBaseUrl: RELAY,
    },
    exchange: {
      github: async (code) => {
        check(code === "provider-code-from-github", "relay passed the provider's code to the exchange");
        return { providerUserId: "e2e-1", email: "rowan@example.com", displayName: "Rowan", avatarUrl: null };
      },
    },
  },
});
await relay.listen({ port: PORT, host: "127.0.0.1" });
step("relay listening", `${RELAY}, data dir ${DATA_DIR}`);

// The desktop side's listener, shaped like src-tauri/src/relay_sign_in.rs:
// anything but GET /callback is a 404 and the wait carries on.
let resolveCallback!: (params: URLSearchParams) => void;
const callbackReceived = new Promise<URLSearchParams>((resolve) => (resolveCallback = resolve));
const listener = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("You can close this tab and go back to Legato.");
  resolveCallback(url.searchParams);
});
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/callback`;
step("loopback listener bound", redirectUri);

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());

// 1. The system browser opens the relay's start URL.
const start = await fetch(
  `${RELAY}/auth/github?${new URLSearchParams({
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`,
  { redirect: "manual" },
);
const authorize = new URL(start.headers.get("location") ?? "");
const state = authorize.searchParams.get("state");
const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
check(start.status === 302 && authorize.host === "github.com" && state, "start redirects to GitHub with a state");
check(
  authorize.searchParams.get("redirect_uri") === `${RELAY}/auth/github/callback`,
  "provider redirect_uri is still the relay's own callback",
);
step("start → GitHub authorize", `redirect_uri=${authorize.searchParams.get("redirect_uri")}`);

// 2. GitHub calls the relay back; the browser carries the state cookie.
const callback = await fetch(
  `${RELAY}/auth/github/callback?code=provider-code-from-github&state=${encodeURIComponent(state)}`,
  { redirect: "manual", headers: { cookie: stateCookie } },
);
const loopback = callback.headers.get("location") ?? "";
check(callback.status === 302 && loopback.startsWith(`${redirectUri}?code=`), "callback 302s to the loopback");
check(!/relay_session=/.test(callback.headers.get("set-cookie") ?? ""), "no browser session cookie set");
step("provider callback → loopback", loopback.replace(/code=[^&]+/, "code=…"));

// 3. The browser follows the 302 to the listener.
const page = await fetch(loopback);
check(page.status === 200, "listener served the close-this-tab page");
const params = await callbackReceived;
const code = params.get("code");
check(code, "listener received a code");
listener.close();
step("listener got the code and closed", `"${await page.text()}"`);

// 4. The app redeems it.
const redeem = (body: Record<string, string>) =>
  fetch(`${RELAY}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
    body: JSON.stringify(body),
  });
const tokenRes = await redeem({ code, code_verifier: verifier, redirect_uri: redirectUri });
const token = (await tokenRes.json()) as { token: string; expiresAt: string; user: { displayName: string } };
check(tokenRes.status === 200 && token.token, "token redeemed");
check(tokenRes.headers.get("access-control-allow-origin") === APP_ORIGIN, "CORS allows the Tauri origin");
check(!tokenRes.headers.has("access-control-allow-credentials"), "no Allow-Credentials");
step("POST /auth/token", `user=${token.user.displayName}, expires ${token.expiresAt}`);

const replay = await redeem({ code, code_verifier: verifier, redirect_uri: redirectUri });
const replayBody = (await replay.json()) as { reason: string; message: string };
check(replay.status === 400, "a second redemption of the same code is refused");
step("replayed code refused", `${replayBody.reason}: ${replayBody.message}`);

const auth = { Authorization: `Bearer ${token.token}`, Origin: APP_ORIGIN };
const me = (await (await fetch(`${RELAY}/auth/me`, { headers: auth })).json()) as { user: { email: string } | null };
check(me.user?.email === "rowan@example.com", "/auth/me knows the bearer");
step("GET /auth/me with Bearer", me.user.email);

await fetch(`${RELAY}/auth/logout`, { method: "POST", headers: auth });
const after = (await (await fetch(`${RELAY}/auth/me`, { headers: auth })).json()) as { user: unknown };
check(after.user === null, "the token is dead after logout");
step("POST /auth/logout with Bearer", "token no longer recognized");

const leftover = db.prepare("SELECT (SELECT COUNT(*) FROM relay_native_requests) AS pending, (SELECT COUNT(*) FROM relay_auth_codes WHERE used_at IS NULL) AS unspent").get();
step("database left clean", JSON.stringify(leftover));

await relay.close();
console.log("end-to-end passed");
