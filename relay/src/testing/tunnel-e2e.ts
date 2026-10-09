// Local end-to-end for issue #310: two home servers claimed to one
// account both hold their tunnels open through a real relay process, a
// request through the relay reaches the server it names, audio streams
// through the existing stream route, the inputs that used to crash the
// relay or a server don't, a hostile server can't frame a second response
// or touch legato.fm's cookies, the servers come back after the relay is
// killed and restarted, a revoked credential stops its server, a link
// through the relay that brings a new credential gets its answer, and
// unlinking with a stream playing answers and then closes the tunnel. No
// real provider, and nothing sent to auth.legato.fm.
//
// It starts everything itself, as child processes, so it can kill the
// relay outright (SIGKILL, no goodbye) the way a crash or a deploy would:
//
//   RELAY_SIGNING_KEYS="[$(bun scripts/generate-signing-key.ts)]" \
//   RELAY_PORT=8911 LEGATO_PORTS=8901,5181 E2E_DIR=<a fresh throwaway dir> \
//   bun src/testing/tunnel-e2e.ts
//
// E2E_DIR gets the relay's and both servers' data dirs, a generated FLAC,
// and each process's log. The relay runs as relay/src/index.ts does in
// production, so the account and its session are made straight in its db
// rather than through a provider; the claims then go through
// POST /pair/claim and each server's /setup check-ins like a real one.
// Needs ffmpeg on PATH, for the FLAC.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { connect } from "node:net";
import { createSession, upsertUser } from "../accounts.js";
import { openDb } from "../db.js";
import { mintTunnelCredential } from "../pairing.js";
import { parseSigningKeys, signServerToken } from "../signing-keys.js";
import { openSqlite } from "../sqlite.js";

const RELAY_PORT = process.env.RELAY_PORT;
const PORTS = (process.env.LEGATO_PORTS ?? "").split(",").filter(Boolean);
const DIR = process.env.E2E_DIR;
if (!RELAY_PORT || PORTS.length !== 2 || !DIR || !process.env.RELAY_SIGNING_KEYS) {
  console.error("Set RELAY_PORT, LEGATO_PORTS (two, comma-separated), E2E_DIR and RELAY_SIGNING_KEYS explicitly.");
  process.exit(2);
}
if (existsSync(path.join(DIR, "relay"))) {
  console.error(`${DIR} has been used before; give E2E_DIR a fresh directory.`);
  process.exit(2);
}
mkdirSync(DIR, { recursive: true });

const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const RELAY_DIR = path.join(import.meta.dirname, "..", "..");
const SERVER_DIR = path.join(RELAY_DIR, "..", "server");
const PASSWORD = "tunnel e2e password";

const children: ChildProcess[] = [];
const step = (label: string, detail = "") => console.log(`ok  ${label}${detail ? `  ${detail}` : ""}`);
function check(cond: unknown, label: string): asserts cond {
  if (!cond) {
    console.error(`FAIL ${label}`);
    for (const child of children) child.kill("SIGKILL");
    process.exit(1);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    check(Date.now() < deadline, `${label} (gave up after ${timeoutMs / 1000} s)`);
    await sleep(200);
  }
}

function start(name: string, cwd: string, env: Record<string, string>): ChildProcess {
  const log = createWriteStream(path.join(DIR!, `${name}.log`), { flags: "a" });
  const child = spawn("bun", ["src/index.ts"], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  children.push(child);
  return child;
}
const logOf = (name: string) => readFileSync(path.join(DIR!, `${name}.log`), "utf8");
// What the tunnel client logs (server/src/tunnel/), and nothing else that
// happens to say "tunnel", like a data dir's path.
const TUNNEL_LINES = /legato\.fm: (tunnel|couldn't open the tunnel)|tunnel credential/g;
const tunnelLines = (name: string) => (logOf(name).match(TUNNEL_LINES) ?? []).length;

function startRelay(): ChildProcess {
  return start("relay", RELAY_DIR, {
    RELAY_PORT: RELAY_PORT!,
    RELAY_DATA_DIR: path.join(DIR!, "relay"),
    RELAY_AUTH_CALLBACK_BASE_URL: RELAY,
  });
}

// 0. A relay, and two fresh servers that trust it.
let relayProcess = startRelay();
await until("the relay answers /health", async () => (await fetch(`${RELAY}/health`)).ok);
const servers = PORTS.map((port, i) => {
  const name = `server-${"ab"[i]}`;
  start(name, SERVER_DIR, {
    LEGATO_PORT: port,
    LEGATO_DATA_DIR: path.join(DIR, name),
    LEGATO_ID_ORIGIN: RELAY,
    LEGATO_UPDATE_CHECK: "off",
    LEGATO_MDNS: "off",
    LEGATO_SERVER_NAME: name,
  });
  return { name, api: `http://127.0.0.1:${port}/api/v1`, dataDir: path.join(DIR, name), id: "", token: "" };
});
for (const server of servers) await until(`${server.name} answers /health`, async () => (await fetch(`${server.api}/health`)).ok);
step("relay and two servers up", `${RELAY}, ${servers.map((s) => s.api).join(", ")}`);
await sleep(1_000);
check(tunnelLines("server-a") + tunnelLines("server-b") === 0, "a server that isn't linked never opens a tunnel");

// 1. One account claims both servers, and each one links it.
const relayDb = openDb(path.join(DIR, "relay", "relay.db"));
const account = upsertUser(relayDb, "github", {
  providerUserId: "e2e-310",
  email: "rowan@example.com",
  emailVerified: true,
  displayName: "Rowan",
  avatarUrl: null,
});
const { token: sessionToken } = createSession(relayDb, account.id);
const cookie = `relay_session=${sessionToken}`;
type Listed = { servers: { serverId: string; tunnel: { connected: boolean; connectedAt?: string; lastSeenAt?: string | null } }[] };
const yourServers = async () =>
  ((await (await fetch(`${RELAY}/linked-servers`, { headers: { authorization: `Bearer ${sessionToken}` } })).json()) as Listed).servers;
const tunnelOf = async (serverId: string) => (await yourServers()).find((s) => s.serverId === serverId)?.tunnel;

for (const server of servers) {
  type Setup = { code: string; claim: { state: string; account?: { id: string } } };
  const setup = async () => (await (await fetch(`${server.api}/auth/setup`)).json()) as Setup;
  const { code } = await setup();
  const claimed = await fetch(`${RELAY}/pair/claim`, {
    method: "POST",
    headers: { cookie, origin: RELAY, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  check(claimed.ok, `the account claims ${server.name}'s code (${claimed.status})`);
  const view = await until(`${server.name} picks the claim up`, async () => {
    const { claim } = await setup();
    return claim.state === "claimed" ? claim : null;
  });
  const ownerRes = await fetch(`${server.api}/auth/owner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, linkAccountId: view.account!.id }),
  });
  const owner = (await ownerRes.json()) as { token: string; legato?: { linked: { accountId: string } | null } };
  check(ownerRes.status === 201 && owner.legato?.linked?.accountId === String(account.id), `${server.name}'s owner links the account`);
  server.token = owner.token;
  server.id = ((await (await fetch(`${server.api}/auth/status`)).json()) as { legato: { serverId: string } }).legato.serverId;
  await until(`${server.name}'s tunnel connects`, async () => (await tunnelOf(server.id))?.connected);
  step(`${server.name} claimed, linked and connected`, `id ${server.id}`);
}

// 2. Both stay connected, and the relay reaches the server each request names.
const listed = await yourServers();
check(listed.length === 2 && listed.every((s) => s.tunnel.connected), `both servers connected at once (${JSON.stringify(listed)})`);
for (const server of servers) {
  const res = await fetch(`${RELAY}/relay/${server.id}/api/v1/auth/status`, { headers: { cookie } });
  const body = (await res.json()) as { legato: { serverId: string } };
  check(res.status === 200 && body.legato.serverId === server.id, `GET /relay/${server.id}/api/v1/auth/status reaches ${server.name}`);
  const me = await fetch(`${RELAY}/relay/${server.id}/api/v1/library-roots`, {
    headers: { cookie, authorization: `Bearer ${server.token}` },
  });
  check(me.status === 200, `${server.name}'s own session works through the relay (${me.status})`);
}
const crossed = await fetch(`${RELAY}/relay/${servers[0]!.id}/api/v1/library-roots`, {
  headers: { cookie, authorization: `Bearer ${servers[1]!.token}` },
});
check(crossed.status === 401, `server-b's session doesn't open server-a (${crossed.status})`);
step("each request reached the server it named", "auth/status answered with its own id; each owner's session works only on its own server");

// 3. Audio through the existing stream route, while the request loop keeps answering.
const musicDir = path.join(DIR, "music");
mkdirSync(musicDir, { recursive: true });
const flac = path.join(musicDir, "noise.flac");
execFileSync("ffmpeg", ["-f", "lavfi", "-i", "anoisesrc=duration=60:amplitude=0.3", "-ar", "44100", flac], { stdio: "ignore" });
const serverDb = openSqlite(path.join(servers[0]!.dataDir, "legato.db"));
const root = serverDb.prepare("INSERT INTO library_roots (path) VALUES (?) RETURNING id").get(musicDir) as { id: number };
const node = serverDb.prepare("INSERT INTO nodes (type, title) VALUES ('recording', 'noise') RETURNING id").get() as { id: number };
serverDb.prepare("INSERT INTO recordings (node_id) VALUES (?)").run(node.id);
const { id: fileId } = serverDb
  .prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, file_hash)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 0, 'e2e310e2e310e2e310e2e310e2e310e2e310e2e3') RETURNING id`,
  )
  .get(node.id, root.id, flac) as { id: number };
// Half an hour, for a stream still playing when the owner unlinks (6).
const longFlac = path.join(musicDir, "long.flac");
execFileSync("ffmpeg", ["-f", "lavfi", "-i", "sine=frequency=440:duration=1800", longFlac], { stdio: "ignore" });
const { id: longFileId } = serverDb
  .prepare(
    `INSERT INTO files (recording_node_id, library_root_id, file_path, file_mtime, file_size, file_hash)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 0, 'e2e310a2e310e2e310e2e310e2e310e2e310e2e3') RETURNING id`,
  )
  .get(node.id, root.id, longFlac) as { id: number };
serverDb.close();
const source = readFileSync(flac);

// Streams one quality through the relay while /health is probed directly
// every 20 ms, so a stream that held up the request loop would show.
async function streamThroughRelay(quality: string) {
  const healthTimes: number[] = [];
  let streaming = true;
  const probing = (async () => {
    while (streaming) {
      const probeStarted = performance.now();
      await fetch(`${servers[0]!.api}/health`);
      healthTimes.push(performance.now() - probeStarted);
      await sleep(20);
    }
  })();
  const started = performance.now();
  const res = await fetch(`${RELAY}/relay/${servers[0]!.id}/api/v1/files/${fileId}/stream?quality=${quality}`, {
    headers: { cookie, authorization: `Bearer ${servers[0]!.token}` },
  });
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let firstByteMs = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstByteMs) firstByteMs = performance.now() - started;
    parts.push(value);
  }
  const totalMs = performance.now() - started;
  streaming = false;
  await probing;
  return { res, body: Buffer.concat(parts), firstByteMs, totalMs, probes: healthTimes.length, worstHealth: Math.max(...healthTimes) };
}
const describe = (r: Awaited<ReturnType<typeof streamThroughRelay>>) =>
  `${(r.body.length / 1e6).toFixed(1)} MB in ${r.totalMs.toFixed(0)} ms, first byte at ${r.firstByteMs.toFixed(0)} ms, ` +
  `${r.probes} /health probes meanwhile, worst ${r.worstHealth.toFixed(0)} ms`;

const original = await streamThroughRelay("original");
check(
  original.res.status === 200 && original.body.equals(source),
  `the FLAC came through byte for byte (${original.body.length} of ${source.length})`,
);
check(
  original.worstHealth < 250,
  `the request loop kept answering while the FLAC streamed (worst /health ${original.worstHealth.toFixed(0)} ms)`,
);
const ranged = await fetch(`${RELAY}/relay/${servers[0]!.id}/api/v1/files/${fileId}/stream?quality=original`, {
  headers: { cookie, authorization: `Bearer ${servers[0]!.token}`, range: "bytes=1000-1999" },
});
check(
  ranged.status === 206 && Buffer.from(await ranged.arrayBuffer()).equals(source.subarray(1000, 2000)),
  "a Range request comes back 206",
);
step("original through GET /api/v1/files/:id/stream", `${describe(original)}; Range → 206`);

// The relay's default quality (plan 03): a fresh transcode, streamed as
// ffmpeg writes it.
const opus = await streamThroughRelay("opus160");
check(opus.res.status === 200 && opus.res.headers.get("content-type")?.startsWith("audio/"), `opus160 streams (${opus.res.status})`);
check(opus.body.subarray(0, 4).toString() === "OggS", "opus160 is an Ogg stream");
check(opus.worstHealth < 250, `the request loop kept answering while it transcoded (worst /health ${opus.worstHealth.toFixed(0)} ms)`);
step("opus160 through the relay, fresh transcode", describe(opus));

// 3b. What used to crash a server or the relay, from PR #341's review.
// Each runs against the live processes, then both still answer.
const stillUp = async (label: string) => {
  check((await fetch(`${RELAY}/health`)).ok, `the relay is still up after ${label}`);
  for (const server of servers) check((await fetch(`${server.api}/health`)).ok, `${server.name} is still up after ${label}`);
  check((await tunnelOf(servers[0]!.id))?.connected === true, `server-a's tunnel is still up after ${label}`);
};

// A path with raw UTF-8 in it, sent as bytes the way a careless client
// would: fetch() would percent-encode it first.
const rawUtf8 = await new Promise<string>((resolve, reject) => {
  const socket = connect(Number(RELAY_PORT), "127.0.0.1", () => {
    socket.write(
      Buffer.from(
        `GET /relay/${servers[0]!.id}/api/v1/search?q=日本 HTTP/1.1\r\nHost: 127.0.0.1:${RELAY_PORT}\r\n` +
          `Cookie: ${cookie}\r\nAuthorization: Bearer ${servers[0]!.token}\r\nConnection: close\r\n\r\n`,
        "utf8",
      ),
    );
  });
  let answer = "";
  socket.on("data", (chunk) => (answer += chunk.toString("utf8")));
  socket.on("end", () => resolve(answer.split("\r\n")[0]!));
  socket.on("error", reject);
});
await stillUp("a raw UTF-8 path");
step("raw UTF-8 path through the relay", `${rawUtf8}; relay and both servers still up`);

// A percent-encoded server id, which used to cut the forwarded path short.
const encodedId = `%${servers[0]!.id.charCodeAt(0).toString(16)}${servers[0]!.id.slice(1)}`;
const viaEncoded = await fetch(`${RELAY}/relay/${encodedId}/api/v1/health`, { headers: { cookie } });
const encodedBody = (await viaEncoded.json()) as { status?: string };
check(viaEncoded.status === 200 && encodedBody.status === "ok", `an encoded id reaches /api/v1/health (${viaEncoded.status})`);
step("percent-encoded server id", "reached the server's own /api/v1/health");

// A hostile home server: a third server linked to the account, whose
// tunnel answers every request with whatever frames it's given. Each input
// gets a tunnel of its own, since most of them get it closed.
const hostileId = "e2e0".padEnd(32, "0");
relayDb.prepare("INSERT INTO linked_servers (relay_user_id, server_id, public_key) VALUES (?, ?, ?)").run(account.id, hostileId, "e2e");
async function hostileTunnel(frames: object[]): Promise<{ closed: boolean }> {
  const credential = mintTunnelCredential(relayDb, account.id, hostileId).token;
  const socket = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/tunnel`);
  const state = { closed: false };
  socket.addEventListener("close", () => (state.closed = true));
  await new Promise<void>((resolve) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credential })));
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; requestId: string };
      if (frame.type === "auth-ok") resolve();
      if (frame.type === "request") for (const out of frames) socket.send(JSON.stringify({ requestId: frame.requestId, ...out }));
    });
  });
  return state;
}
const text = (data: string) => ({ type: "response-chunk", data: Buffer.from(data).toString("base64") });
const END = { type: "response-end" };
const hostileUrl = `${RELAY}/relay/${hostileId}/x`;

let hostile = await hostileTunnel([{ type: "response-start", status: 99999, headers: {} }]);
const badStatus = await fetch(hostileUrl, { headers: { cookie } });
check(badStatus.status === 502 && !hostile.closed, `a status of 99999 becomes a 502, and the tunnel stays (${badStatus.status})`);
await stillUp("a status of 99999");

// Bytes past a Content-Length, which a pooled keep-alive connection
// would read as the answer to someone else's next request.
hostile = await hostileTunnel([
  { type: "response-start", status: 200, headers: { "content-length": "5" } },
  text("helloHTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 7\r\n\r\nsmuggle"),
  END,
]);
const smuggled = await new Promise<{ wire: string; closed: boolean }>((resolve) => {
  const socket = connect(Number(RELAY_PORT), "127.0.0.1", () =>
    socket.write(
      `GET /relay/${hostileId}/x HTTP/1.1\r\nHost: 127.0.0.1:${RELAY_PORT}\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`,
    ),
  );
  let wire = "";
  socket.on("data", (chunk) => (wire += chunk.toString("latin1")));
  socket.on("error", () => {});
  socket.on("close", () => resolve({ wire, closed: true }));
  setTimeout(() => {
    socket.destroy();
    resolve({ wire, closed: false });
  }, 2_000);
});
check(!smuggled.wire.includes("smuggle"), `no second response reaches the connection (${JSON.stringify(smuggled.wire.slice(-80))})`);
check(smuggled.closed, "the device's connection is broken off, not left open for reuse");
await until("the relay closes a tunnel that overran its Content-Length", async () => hostile.closed, 5_000);
await stillUp("a body past its Content-Length");

// A Content-Length that isn't a number used to break the device's parser.
hostile = await hostileTunnel([{ type: "response-start", status: 200, headers: { "content-length": "5x" } }, text("hello"), END]);
const oddLength = await fetch(hostileUrl, { headers: { cookie } });
check(oddLength.status === 200 && (await oddLength.text()) === "hello", "a Content-Length that isn't a number is left off");

// legato.fm's cookies, storage and address bar.
hostile = await hostileTunnel([
  {
    type: "response-start",
    status: 302,
    headers: {
      location: "https://elsewhere.example/",
      refresh: "0; url=https://elsewhere.example/",
      "clear-site-data": '"cookies", "storage"',
      "set-cookie": "relay_session=planted; Path=/",
      "content-type": "text/plain",
    },
  },
  text("moved"),
  END,
]);
const redirect = await fetch(hostileUrl, { headers: { cookie }, redirect: "manual" });
const leaked = ["location", "refresh", "clear-site-data", "set-cookie"].filter((name) => redirect.headers.has(name));
check(redirect.status === 302 && leaked.length === 0, `no Location, Refresh, Clear-Site-Data or Set-Cookie reaches the device (${leaked})`);
check(!hostile.closed, "the tunnel stays after headers that are only left off");

// An end before any status used to pass for a bare 200.
hostile = await hostileTunnel([END]);
const endFirst = await fetch(hostileUrl, { method: "DELETE", headers: { cookie } });
check(endFirst.status === 502, `an answer that ends before it starts is a 502 (${endFirst.status})`);
await until("the relay closes a tunnel that ended before it started", async () => hostile.closed, 5_000);
await stillUp("an end before any status");

hostile = await hostileTunnel([{ type: "response-start", status: 200, headers: {} }, { type: "response-chunk", data: 42 }]);
await fetch(hostileUrl, { headers: { cookie } })
  .then((res) => res.arrayBuffer())
  .catch(() => null);
await until("the relay closes the hostile tunnel", async () => hostile.closed, 5_000);
await stillUp("a chunk that isn't base64 text");
step(
  "hostile tunnel",
  "99999 → 502; no smuggled response, connection broken off; a non-numeric length left off; no Location, Refresh, " +
    "Clear-Site-Data or Set-Cookie; end-before-start → 502; each overrun, early end and bad chunk closed its tunnel; " +
    "relay and both servers still up",
);
// Off the account again, so "your servers" is the two real ones.
relayDb.prepare("DELETE FROM linked_servers WHERE server_id = ?").run(hostileId);
relayDb.prepare("DELETE FROM tunnel_credentials WHERE server_id = ?").run(hostileId);

// 4. Kill the relay outright, then bring it back: both servers reconnect.
relayProcess.kill("SIGKILL");
await new Promise((resolve) => relayProcess.once("exit", resolve));
for (const server of servers)
  await until(`${server.name} notices the relay is gone`, async () => logOf(server.name).includes("tunnel dropped"));
const downAt = Date.now();
await sleep(3_000);
relayProcess = startRelay();
await until("the relay is back", async () => (await fetch(`${RELAY}/health`)).ok);
const backAt = Date.now();
await until("both servers reconnect", async () => (await yourServers()).every((s) => s.tunnel.connected), 90_000);
const reconnectedMs = Date.now() - backAt;
for (const server of servers) {
  const res = await fetch(`${RELAY}/relay/${server.id}/api/v1/auth/status`, { headers: { cookie } });
  check(res.ok, `${server.name} answers through the restarted relay`);
}
step(
  "relay killed and restarted",
  `down ${((backAt - downAt) / 1000).toFixed(1)} s; both servers back ${(reconnectedMs / 1000).toFixed(1)} s after it was`,
);

// 5. Revoke server-b's credential: the relay closes its tunnel at the next
// heartbeat, server-b stops with one warning (its next try is an hour
// away), and server-a carries on.
relayDb.prepare("DELETE FROM tunnel_credentials WHERE server_id = ?").run(servers[1]!.id);
await until("server-b's tunnel closes", async () => (await tunnelOf(servers[1]!.id))?.connected === false, 45_000);
await until("server-b says why it stopped", async () => logOf("server-b").includes("refused this server's tunnel credential"));
const before = tunnelLines("server-b");
await sleep(5_000);
check(tunnelLines("server-b") === before, "server-b doesn't try again on the short backoff");
check((logOf("server-b").match(/refused this server's tunnel credential/g) ?? []).length === 1, "server-b warned once");
check((await tunnelOf(servers[0]!.id))?.connected === true, "server-a is still connected");
const gone = await fetch(`${RELAY}/relay/${servers[1]!.id}/api/v1/auth/status`, { headers: { cookie } });
check(gone.status === 503, `server-b can't be reached through the relay (${gone.status})`);
step("credential revoked", `server-b stopped with one warning; server-a still connected; GET /relay/<b>/… → ${gone.status}`);

// 6. server-a's owner links again from a phone, through legato.fm, with a
// link token that brings a new credential: what a claim's /pair/exchange
// signs, and every link after #342. The answer comes back down the tunnel
// the new credential replaces.
const storedCredential = () => {
  const db = openSqlite(path.join(servers[0]!.dataDir, "legato.db"));
  const row = db.prepare("SELECT credential FROM tunnel_credential").get() as { credential: string } | null;
  db.close();
  return row?.credential ?? null;
};
const credentialBefore = storedCredential();
const keys = parseSigningKeys(process.env.RELAY_SIGNING_KEYS)!;
type RelayUser = Parameters<typeof signServerToken>[1]["user"];
const relayUser = relayDb.prepare("SELECT * FROM relay_users WHERE id = ?").get(account.id) as RelayUser;
const linkToken = signServerToken(keys, { issuer: RELAY, user: relayUser, serverId: servers[0]!.id, scope: "link", tunnel: true }).token;
const relink = await fetch(`${RELAY}/relay/${servers[0]!.id}/api/v1/auth/legato/link`, {
  method: "POST",
  headers: { cookie, authorization: `Bearer ${servers[0]!.token}`, "content-type": "application/json" },
  body: JSON.stringify({ token: linkToken }),
});
const relinked = (await relink.json()) as { linked?: { accountId: string } };
check(
  relink.status === 200 && relinked.linked?.accountId === String(account.id),
  `server-a links again through the relay and hears back (${relink.status})`,
);
await until("server-a stores the new credential", async () => storedCredential() !== credentialBefore);
await until("server-a's tunnel connects with it", async () => (await tunnelOf(servers[0]!.id))?.connected);
const reached = await fetch(`${RELAY}/relay/${servers[0]!.id}/api/v1/auth/status`, { headers: { cookie } });
check(reached.ok, "server-a answers through its new tunnel");
step("server-a linked again through the relay", `answered ${relink.status}; the new credential's tunnel took over`);

// 7. server-a's owner unlinks from a phone, through legato.fm, with a
// transcode still playing: the answer comes back down the tunnel the
// unlink closes, then the stream is cut off, the tunnel closes and the
// credential goes.
const playing = await fetch(`${RELAY}/relay/${servers[0]!.id}/api/v1/files/${longFileId}/stream?quality=opus160`, {
  headers: { cookie, authorization: `Bearer ${servers[0]!.token}` },
});
const player = playing.body!.getReader();
check(playing.status === 200 && !(await player.read()).done, `a stream is playing (${playing.status})`);
const unlinkStarted = performance.now();
const unlink = await fetch(`${RELAY}/relay/${servers[0]!.id}/api/v1/auth/legato/link`, {
  method: "DELETE",
  headers: { cookie, authorization: `Bearer ${servers[0]!.token}` },
});
const unlinkMs = performance.now() - unlinkStarted;
check(unlink.ok, `server-a unlinks through the relay with music on, and hears back (${unlink.status})`);
const cutOff = await (async () => {
  try {
    for (;;) if ((await player.read()).done) return "ended";
  } catch {
    return "broken off";
  }
})();
check(cutOff === "broken off", `the stream still playing is broken off, not ended as if whole (${cutOff})`);
await until("server-a's tunnel closes", async () => {
  const listedNow = await yourServers();
  return !listedNow.some((s) => s.serverId === servers[0]!.id && s.tunnel.connected);
});
check(storedCredential() === null, "server-a forgot its credential");
await sleep(3_000);
check(!logOf("server-a").includes("refused this server's tunnel credential"), "server-a never asks legato.fm again after the unlink");
step(
  "server-a unlinked through the relay with a stream playing",
  `answered ${unlink.status} in ${unlinkMs.toFixed(0)} ms; the stream was ${cutOff}, ` +
    "then the tunnel closed and the credential was forgotten",
);

for (const child of children) child.kill("SIGTERM");
relayDb.close();
console.log(`end-to-end passed; logs in ${DIR}`);
process.exit(0);
