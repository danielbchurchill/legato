// Local end-to-end for issue #325: a home server linked to legato.fm from
// its own web client, in headless Chrome. The first link from Settings is
// made to fail (this relay drops the server's report, as if legato.fm
// couldn't be reached), the owner tries again and it links, then links once
// more to check the old tunnel credential is retired. Then the review's
// cases: a redeem that's rate limited keeps its code for "try again", Back
// from legato.fm leaves the button ready, and a code that comes back to a
// tab with no verifier says the link didn't finish. No real provider, and
// nothing sent to auth.legato.fm: GitHub's authorize page is answered inside
// Chrome.
//
// Two ways to the owner. By default it's created over the API without a
// claim, as on every server set up before #237. With LINK_E2E_SETUP=claim
// it's the issue's own case: the browser opens /setup, an account claims
// the code, the owner is created with that account, and the link at that
// moment is made to fail, so /setup has to say where to try again. /setup
// only shows a claim to a page that isn't on loopback, so that run uses the
// machine's LAN address for both (RELAY_PUBLIC_URL=http://<LAN IP>:8912,
// LEGATO_SERVER=http://<LAN IP>:8902, and the server's LEGATO_ID_ORIGIN to
// match): a page on a LAN address can't fetch a loopback one in Chrome.
//
// Starts a relay on RELAY_PORT (stubbed GitHub exchange, throwaway
// RELAY_DATA_DIR, signing key from RELAY_SIGNING_KEYS) and drives a home
// server that's already running with the web client built (`npm run build`),
// LEGATO_ID_ORIGIN pointed at this relay, and a headless Chrome that's
// already listening on CHROME_DEBUG_PORT:
//
//   RELAY_SIGNING_KEYS="[$(bun scripts/generate-signing-key.ts)]" \
//   RELAY_PORT=8912 RELAY_DATA_DIR=<throwaway dir> \
//   LEGATO_SERVER=http://127.0.0.1:8902 LEGATO_DATA_DIR=<the server's data dir> \
//   LEGATO_OWNER_PASSWORD=<at least 8 characters> \
//   CHROME_DEBUG_PORT=9342 SCREENSHOT_DIR=<a dir> \
//   bun src/testing/link-e2e.ts
//
// The server: LEGATO_ID_ORIGIN=http://127.0.0.1:8912 LEGATO_PORT=8902
// LEGATO_UPDATE_CHECK=off LEGATO_DATA_DIR=<a fresh dir> bun server/src/index.ts.
// Or the compiled Linux binary in Docker (debian:bookworm-slim, the binary
// mounted at /legato-server): set LEGATO_DOCKER_CONTAINER to its name and
// LEGATO_DATA_DIR to its data dir inside the container, and the server's
// database is read in there, by the binary running as bun. SQLite's WAL
// index isn't shared reliably across Docker Desktop's file share.
// Chrome: Google Chrome --headless=new --remote-debugging-port=9342
// --user-data-dir=<a fresh dir> about:blank.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSession, upsertUser } from "../accounts.js";
import { buildApp } from "../app.js";
import { DATA_DIR, PORT } from "../config.js";
import { openDb } from "../db.js";
import { openSqlite } from "../sqlite.js";

const SERVER = process.env.LEGATO_SERVER;
const SERVER_DATA_DIR = process.env.LEGATO_DATA_DIR;
const PASSWORD = process.env.LEGATO_OWNER_PASSWORD;
const CHROME_PORT = process.env.CHROME_DEBUG_PORT;
const SHOTS = process.env.SCREENSHOT_DIR;
if (
  !process.env.RELAY_PORT ||
  !process.env.RELAY_DATA_DIR ||
  !process.env.RELAY_SIGNING_KEYS ||
  !SERVER ||
  !SERVER_DATA_DIR ||
  !PASSWORD ||
  !CHROME_PORT ||
  !SHOTS
) {
  console.error(
    "Set RELAY_PORT, RELAY_DATA_DIR, RELAY_SIGNING_KEYS, LEGATO_SERVER, LEGATO_DATA_DIR, LEGATO_OWNER_PASSWORD, CHROME_DEBUG_PORT and SCREENSHOT_DIR explicitly.",
  );
  process.exit(2);
}

const RELAY = process.env.RELAY_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;
const API = `${SERVER}/api/v1`;
const VIA_CLAIM = process.env.LINK_E2E_SETUP === "claim";

const step = (label: string, detail = "") => console.log(`ok  ${label}${detail ? `  ${detail}` : ""}`);
function check(cond: unknown, label: string): asserts cond {
  if (!cond) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the relay, with a stubbed GitHub and a report it drops once ---

const db = openDb();
const relay = buildApp({
  db,
  auth: {
    config: { githubClientId: "e2e-not-a-real-client", githubClientSecret: "e2e-not-a-real-secret", callbackBaseUrl: RELAY },
    exchange: {
      github: async () => ({
        providerUserId: "e2e-325",
        email: "rowan@example.com",
        emailVerified: true,
        displayName: "Rowan",
        avatarUrl: null,
      }),
    },
  },
});
let dropReports = 0;
let limitRedeems = 0;
relay.addHook("onRequest", async (request, reply) => {
  if (request.method === "POST" && request.url === "/linked-servers" && dropReports > 0) {
    dropReports--;
    // Hung up on, as a server sees legato.fm down: a fetch that throws.
    reply.hijack();
    request.raw.socket.destroy();
  }
  if (request.method === "POST" && request.url === "/link/redeem" && limitRedeems > 0) {
    limitRedeems--;
    // The answer /link/redeem gives an address that's tried too often,
    // before it looks at the code.
    return reply
      .code(429)
      .header("Access-Control-Allow-Origin", request.headers.origin ?? "*")
      .header("Retry-After", "1")
      .send({ error: "Too many failed link attempts from this address. Try again in 1 seconds.", reason: "rate_limited" });
  }
});
await relay.listen({ port: PORT, host: new URL(RELAY).hostname });
step("relay listening", `${RELAY}, data dir ${DATA_DIR}`);

const relayPairs = () => db.prepare("SELECT relay_user_id, server_id FROM linked_servers").all() as { server_id: string }[];
const relayCredentials = () => db.prepare("SELECT token, server_id FROM tunnel_credentials").all() as { token: string; server_id: string }[];

// --- the server ---

const status = (await (await fetch(`${API}/auth/status`)).json()) as {
  ownerExists: boolean;
  legato: { serverId: string; issuer: string };
};
check(status.legato.issuer === RELAY, `the server trusts this relay (LEGATO_ID_ORIGIN=${RELAY}), not ${status.legato.issuer}`);
check(!VIA_CLAIM || !status.ownerExists, "a claim run needs a server with no owner yet (a fresh LEGATO_DATA_DIR)");
const serverId = status.legato.serverId;

const CONTAINER = process.env.LEGATO_DOCKER_CONTAINER;
const serverDbPath = path.join(SERVER_DATA_DIR, "legato.db");
const serverDb = CONTAINER ? null : openSqlite(serverDbPath);
function serverRow<T>(sql: string): T | undefined {
  if (serverDb) return serverDb.prepare(sql).get() as T | undefined;
  const script = `import { Database } from "bun:sqlite"; console.log(JSON.stringify(new Database(${JSON.stringify(serverDbPath)}).prepare(${JSON.stringify(sql)}).get() ?? null))`;
  const run = Bun.spawnSync(["docker", "exec", "-e", "BUN_BE_BUN=1", CONTAINER!, "/legato-server", "-e", script]);
  check(run.exitCode === 0, `read the server's database in ${CONTAINER}: ${run.stderr.toString()}`);
  return (JSON.parse(run.stdout.toString()) as T | null) ?? undefined;
}
const storedCredential = () => serverRow<{ credential: string; account_id: string }>("SELECT credential, account_id FROM tunnel_credential WHERE id = 1");
const linkedAccount = () =>
  serverRow<{ legato_account_id: string | null }>("SELECT legato_account_id FROM users WHERE role = 'owner'")?.legato_account_id ?? null;
check(linkedAccount() === null && !storedCredential(), "the server starts unlinked, with no tunnel credential");

// --- Chrome over CDP ---

mkdirSync(SHOTS, { recursive: true });
const target = (await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/new?about:blank`, { method: "PUT" })).json()) as {
  webSocketDebuggerUrl: string;
};
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let nextId = 1;
const pending = new Map<number, (value: { result?: Record<string, unknown>; error?: unknown }) => void>();
const listeners: ((method: string, params: Record<string, unknown>) => void)[] = [];
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown> };
  if (message.id !== undefined) pending.get(message.id)?.(message as never);
  else if (message.method) for (const listen of listeners) listen(message.method, message.params ?? {});
};
async function cdp(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  const answer = await new Promise<{ result?: Record<string, unknown>; error?: unknown }>((resolve) => pending.set(id, resolve));
  if (answer.error) throw new Error(`${method}: ${JSON.stringify(answer.error)}`);
  return answer.result ?? {};
}
async function evaluate<T>(expression: string): Promise<T> {
  const result = (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
    result: { value: T };
  };
  return result.result.value;
}
async function waitFor(expression: string, label: string, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await evaluate<boolean>(`(() => { try { return Boolean(${expression}) } catch { return false } })()`).catch(() => false)) return;
    await sleep(200);
  }
  // What was on screen instead, for whoever reads the failure.
  console.error(`at ${await location().catch(() => "?")}`);
  await screenshot("timed-out").catch(() => undefined);
  check(false, `timed out waiting for ${label}`);
}
const textIs = (text: string) => `document.body && document.body.innerText.includes(${JSON.stringify(text)})`;
const location = () => evaluate<string>("location.href");
async function click(text: string): Promise<void> {
  await waitFor(`[...document.querySelectorAll('button, a')].some((b) => b.textContent.trim() === ${JSON.stringify(text)})`, `"${text}"`);
  await evaluate(`[...document.querySelectorAll('button, a')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
}
let shot = 0;
async function screenshot(name: string): Promise<void> {
  const { data } = (await cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
  const file = path.join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  step(`screenshot ${file}`);
}

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
// GitHub's authorize page, answered here: straight back to this relay's
// callback with the state it sent, as GitHub does once someone approves.
await cdp("Fetch.enable", { patterns: [{ urlPattern: "https://github.com/*", requestStage: "Request" }] });
listeners.push((method, params) => {
  if (method !== "Fetch.requestPaused") return;
  const url = new URL(params.request && (params.request as { url: string }).url);
  const state = url.searchParams.get("state") ?? "";
  void cdp("Fetch.fulfillRequest", {
    requestId: params.requestId,
    responseCode: 302,
    responseHeaders: [{ name: "Location", value: `${RELAY}/auth/github/callback?code=e2e&state=${encodeURIComponent(state)}` }],
  });
});

async function type(selector: string, text: string): Promise<void> {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await cdp("Input.insertText", { text });
}

await cdp("Page.navigate", { url: `${SERVER}/` });
await waitFor("document.readyState === 'complete'", "the web client");

if (VIA_CLAIM) {
  // The issue's own case: claimed on /setup, and the link made when the
  // owner is created fails.
  await waitFor(textIs("This server's setup code:"), "the setup code on /setup");
  const code = await evaluate<string>(`document.querySelector('p[aria-live="polite"]').textContent.trim()`);
  const user = upsertUser(db, "github", {
    providerUserId: "e2e-325",
    email: "rowan@example.com",
    emailVerified: true,
    displayName: "Rowan",
    avatarUrl: null,
  });
  const claimed = await fetch(`${RELAY}/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `relay_session=${createSession(db, user.id).token}` },
    body: JSON.stringify({ code }),
  });
  check(claimed.ok, `claimed ${code} on legato.fm (${claimed.status})`);
  step("claimed the setup code", code);
  const linkButton = "create owner and link Rowan (r•••@example.com)";
  await waitFor(textIs(linkButton), "the claim on /setup", 30_000);
  await type('input[aria-label="Password"]', PASSWORD);
  await type('input[aria-label="Password again"]', PASSWORD);
  dropReports = 1;
  await click(linkButton);
  await waitFor(textIs("The owner is created, but no account was linked."), "the owner created, unlinked");
  check(
    await evaluate<boolean>(textIs("You can link it later: open Settings and choose link to legato.fm, under legato.fm account.")),
    "/setup says where to try again",
  );
  await screenshot("owner-created-link-failed");
  check(relayPairs().length === 0 && relayCredentials().length === 0, "the claim's failed link left nothing on the relay");
  check(linkedAccount() === null && !storedCredential(), "or on the server");
  step("owner created, first link failed, /setup says where to try again");
  await click("continue");
} else {
  // Every server set up before #237: an owner, and no claim at all.
  const created = await fetch(`${API}/auth/${status.ownerExists ? "sign-in" : "owner"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check(created.ok, `owner session (${created.status})`);
  const session = (await created.json()) as { token: string; mediaTicket: string; legato?: unknown };
  check(session.legato === undefined, "the owner was created without a claim, so nothing tried to link");
  step("owner signed in, no claim", `server ${serverId}`);
  // The owner's session, as the sign-in screen would have stored it.
  await evaluate(
    `localStorage.setItem(${JSON.stringify(`legato:session:${SERVER}`)}, ${JSON.stringify(JSON.stringify({ token: session.token, mediaTicket: session.mediaTicket }))})`,
  );
}

async function openSettings(): Promise<void> {
  await waitFor(`document.querySelector('button[aria-label="Settings"]')`, "the rail");
  const open = await evaluate<boolean>(`document.querySelector('button[aria-label="Settings"]').getAttribute('aria-pressed') === 'true'`);
  if (!open) await evaluate(`document.querySelector('button[aria-label="Settings"]').click()`);
  await waitFor(textIs("legato.fm account"), "Settings' legato.fm account group");
  await sleep(500);
  // To the foot of the panel, where the group is.
  await evaluate(`(() => {
    let el = [...document.querySelectorAll('section')].find((s) => s.textContent.includes('legato.fm account'));
    while (el && !(el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible')) el = el.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  })()`);
  await sleep(300);
}

// 1. Settings says the server isn't linked, and offers the link.
if (!VIA_CLAIM) await cdp("Page.reload");
await openSettings();
await waitFor(textIs("This server isn't linked to a legato.fm account yet."), "the unlinked sentence");
await screenshot("settings-unlinked");

// 2. To legato.fm, signed out: the address it goes back to, and sign-in.
await click("link to legato.fm");
await waitFor(`location.origin === ${JSON.stringify(RELAY)} && document.body.dataset.view === 'signed_out'`, "the signed-out link page");
check((await evaluate<string>("document.querySelector('.address').textContent")) === SERVER, "the page names the server's origin");
await screenshot("link-page-signed-out");
await click("sign in with github");
await waitFor(`location.pathname === '/link' && document.body.dataset.view === 'ready'`, "the ready link page after sign-in");
await screenshot("link-page-ready");

// 3. The first link from Settings: the relay drops the server's report.
dropReports = 1;
await click("link this server");
await waitFor(`location.origin === ${JSON.stringify(SERVER)}`, "back on the server");
check(!(await location()).includes("legato_link"), "the code is out of the address bar");
await waitFor(textIs("couldn't link to legato.fm"), "the failure toast");
check(await evaluate<boolean>(textIs("to record the link, so nothing changed.")), "the toast says why, in the server's words");
await screenshot("first-link-failed");
check(relayPairs().length === 0 && relayCredentials().length === 0, "the relay recorded nothing");
check(linkedAccount() === null && !storedCredential(), "the server stored nothing");
step("first link failed, nothing recorded on either side");

// 4. Again, from Settings: signed in now, so straight to the question.
await openSettings();
await click("link to legato.fm");
await waitFor(`location.origin === ${JSON.stringify(RELAY)} && document.body.dataset.view === 'ready'`, "the ready link page");
await click("link this server");
await waitFor(`location.origin === ${JSON.stringify(SERVER)}`, "back on the server");
await waitFor(textIs("linked to legato.fm"), "the success toast");
await screenshot("linked");
await openSettings();
await waitFor(textIs("This server is linked to legato.fm."), "the linked sentence");
await screenshot("settings-linked");

const pairs = relayPairs();
const credentials = relayCredentials();
check(pairs.length === 1 && pairs[0]!.server_id === serverId, "the relay holds the link");
check(credentials.length === 1 && credentials[0]!.server_id === serverId, "the relay holds one tunnel credential, for this server");
const stored = storedCredential();
check(stored?.credential === credentials[0]!.token, "the server stored that credential");
check(linkedAccount() === stored!.account_id, "the owner is linked to that account");
step("linked on the second try", `account ${stored!.account_id}, credential stored`);

// 5. Cancel says so, and changes nothing.
await click("link again");
await waitFor(`location.origin === ${JSON.stringify(RELAY)} && document.body.dataset.view === 'ready'`, "the ready link page");
await click("cancel");
await waitFor(textIs("nothing linked"), "the cancelled toast");
await screenshot("cancelled");
check(relayCredentials()[0]?.token === stored!.credential, "cancelling changed nothing");

// 6. Linking again retires the old credential.
await openSettings();
await click("link again");
await waitFor(`location.origin === ${JSON.stringify(RELAY)} && document.body.dataset.view === 'ready'`, "the ready link page");
await click("link this server");
await waitFor(textIs("linked to legato.fm"), "the success toast");
const after = relayCredentials();
check(after.length === 1 && after[0]!.token !== stored!.credential, "one credential, a new one");
check(storedCredential()?.credential === after[0]!.token, "the server stored the new one");
step("linking again retired the old credential");

// The relay keeps no plain hash of where a code went (review B2).
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const codeRows = db.prepare("SELECT return_origin_mac, used_at FROM relay_link_codes").all() as { return_origin_mac: string }[];
check(codeRows.length > 0 && codeRows.every((row) => row.return_origin_mac !== sha256(SERVER)), "the return address is kept only as an HMAC");

// 7. A rate-limited redeem keeps the code, and "try again" spends it (B1).
await openSettings();
await click("link again");
await waitFor(`location.origin === ${JSON.stringify(RELAY)} && document.body.dataset.view === 'ready'`, "the ready link page");
limitRedeems = 1;
await click("link this server");
await waitFor(`location.origin === ${JSON.stringify(SERVER)}`, "back on the server");
await waitFor(textIs("Too many failed link attempts from this address."), "the rate-limited toast");
check(await evaluate<boolean>(`sessionStorage.getItem('legato:link-pending') !== null`), "the code and verifier are kept");
const unspent = db.prepare("SELECT COUNT(*) AS n FROM relay_link_codes WHERE used_at IS NULL AND expires_at > datetime('now')").get() as {
  n: number;
};
check(unspent.n === 1, "the relay hasn't spent the code");
await screenshot("rate-limited-try-again");
const beforeRetry = relayCredentials()[0]!.token;
await click("try again");
await waitFor(textIs("This server is linked to Rowan."), "the success toast after trying again");
check(await evaluate<boolean>(`sessionStorage.getItem('legato:link-pending') === null`), "the spent code is gone from the tab");
check(relayCredentials().length === 1 && relayCredentials()[0]!.token !== beforeRetry, "trying again linked, with a new credential");
check(storedCredential()?.credential === relayCredentials()[0]!.token, "and the server stored it");
await screenshot("linked-after-try-again");
step("a rate-limited redeem kept its code, and trying again linked");

// 8. Back from legato.fm, the button is ready again (B4). Chrome only
// restores a page from its back-forward cache when nothing blocks it (an
// open WebSocket can), so the run says which it was.
await openSettings();
await evaluate("window.__e2eLeft = true");
await click("link again");
await waitFor(`location.origin === ${JSON.stringify(RELAY)} && document.body.dataset.view === 'ready'`, "the ready link page");
await evaluate("history.back()");
await waitFor(`location.origin === ${JSON.stringify(SERVER)}`, "back on the server");
const restored = await evaluate<boolean>("window.__e2eLeft === true");
await openSettings();
await waitFor(
  `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'link again' && !b.disabled)`,
  "a ready link again button",
);
await screenshot("back-from-legato-fm");
step("Back from legato.fm leaves the button ready", restored ? "(restored from the back-forward cache)" : "(loaded again, not from the back-forward cache)");

// 9. A code that comes back to a tab with no verifier: an installed web
// app on iOS that opened legato.fm in Safari, say (B7).
await cdp("Page.navigate", { url: "about:blank" });
await evaluate("true");
await cdp("Page.navigate", { url: `${SERVER}/` });
await waitFor("document.readyState === 'complete'", "the web client");
await evaluate("sessionStorage.clear()");
await cdp("Page.navigate", { url: "about:blank" });
await cdp("Page.navigate", { url: `${SERVER}/#legato_link=${"x".repeat(43)}` });
await waitFor(textIs("link didn't finish"), "the didn't-finish toast");
check(!(await location()).includes("legato_link"), "the code is out of the address bar");
check(await evaluate<boolean>(textIs("start again from Settings here")), "it says where to start again");
await screenshot("link-did-not-finish");
step("a code with no verifier says the link didn't finish");

socket.close();
await relay.close();
console.log("all good");
process.exit(0);
