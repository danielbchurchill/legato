// Local end-to-end for issue #310: two home servers claimed to one
// account both hold their tunnels open through a real relay process, a
// request through the relay reaches the server it names, audio streams
// through the existing stream route, the servers come back after the relay
// is killed and restarted, a revoked credential stops its server, and
// unlinking closes the other's tunnel. No real provider, and nothing sent
// to auth.legato.fm.
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
import { createSession, upsertUser } from "../accounts.js";
import { openDb } from "../db.js";
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
// heartbeat, server-b stops with one warning, and server-a carries on.
relayDb.prepare("DELETE FROM tunnel_credentials WHERE server_id = ?").run(servers[1]!.id);
await until("server-b's tunnel closes", async () => (await tunnelOf(servers[1]!.id))?.connected === false, 45_000);
await until("server-b says why it stopped", async () => logOf("server-b").includes("refused this server's tunnel credential"));
const before = tunnelLines("server-b");
await sleep(5_000);
check(tunnelLines("server-b") === before, "server-b doesn't try again");
check((logOf("server-b").match(/refused this server's tunnel credential/g) ?? []).length === 1, "server-b warned once");
check((await tunnelOf(servers[0]!.id))?.connected === true, "server-a is still connected");
const gone = await fetch(`${RELAY}/relay/${servers[1]!.id}/api/v1/auth/status`, { headers: { cookie } });
check(gone.status === 503, `server-b can't be reached through the relay (${gone.status})`);
step("credential revoked", `server-b stopped with one warning; server-a still connected; GET /relay/<b>/… → ${gone.status}`);

// 6. server-a's owner unlinks: its tunnel closes and the credential goes.
const unlink = await fetch(`${servers[0]!.api}/auth/legato/link`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${servers[0]!.token}` },
});
check(unlink.ok, `server-a unlinks (${unlink.status})`);
await until("server-a's tunnel closes", async () => {
  const listedNow = await yourServers();
  return !listedNow.some((s) => s.serverId === servers[0]!.id && s.tunnel.connected);
});
const serverADb = openSqlite(path.join(servers[0]!.dataDir, "legato.db"));
const left = serverADb.prepare("SELECT COUNT(*) AS n FROM tunnel_credential").get() as { n: number };
serverADb.close();
check(left.n === 0, "server-a forgot its credential");
step("server-a unlinked", "tunnel closed, credential forgotten");

for (const child of children) child.kill("SIGTERM");
relayDb.close();
console.log(`end-to-end passed; logs in ${DIR}`);
process.exit(0);
