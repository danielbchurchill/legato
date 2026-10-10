import type { FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { createSession, upsertUser } from "../accounts.js";
import { mintTunnelCredential } from "../pairing.js";
import { TunnelClient, type TunnelClientOptions, type TunnelState } from "../../../server/src/tunnel/client.js";

// Plays the home-server side of the tunnel in tests with the home server's
// own tunnel client (server/src/tunnel/client.ts), so these specs check
// the client legato-server runs against this relay, not a stand-in for
// it. It replays every request against `targetBaseUrl`, a real fixture
// server standing in for the home server's own HTTP port, so the whole
// chain (fixture -> tunnel client -> tunnel -> relay -> device's fetch)
// runs with real I/O.
//
// Retries are fast here: specs restart relays and revoke credentials, and
// shouldn't wait out production's backoff.
export const TEST_BACKOFF = { baseMs: 20, capMs: 200 };

export function startHomeServer(
  options: { tunnelUrl: string; credential: string; targetBaseUrl: string } & Pick<TunnelClientOptions, "heartbeatMs" | "log">,
): TunnelClient {
  const client = new TunnelClient({
    url: options.tunnelUrl,
    credential: options.credential,
    target: options.targetBaseUrl,
    backoff: TEST_BACKOFF,
    heartbeatMs: options.heartbeatMs,
    log: options.log,
  });
  client.start();
  return client;
}

export async function connectHomeServer(options: Parameters<typeof startHomeServer>[0]): Promise<TunnelClient> {
  const client = startHomeServer(options);
  await waitForState(client, "connected");
  return client;
}

export function waitForState(client: TunnelClient, state: TunnelState, timeoutMs = 5_000): Promise<void> {
  if (client.state === state) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`tunnel client stayed ${client.state}, never ${state}`));
    }, timeoutMs);
    const off = client.onState((next) => {
      if (next !== state) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

// What a claim's link leaves on the relay (linked-servers.ts,
// acceptLinkProof): the account's pair with the server, and a tunnel
// credential bound to the server's id. Written straight to the db: the
// proofs themselves are claim.spec.ts's.
let serverCounter = 0;
export function linkServer(db: Database, relayUserId: number, serverId?: string): { serverId: string; credential: string } {
  serverCounter += 1;
  const id = serverId ?? serverCounter.toString(16).padStart(32, "0");
  db.prepare("INSERT OR IGNORE INTO linked_servers (relay_user_id, server_id, public_key) VALUES (?, ?, ?)").run(
    relayUserId,
    id,
    `test-public-key-${id}`,
  );
  return { serverId: id, credential: mintTunnelCredential(db, relayUserId, id).token };
}

export async function listenApp(app: FastifyInstance, port = 0): Promise<{ httpUrl: string; tunnelUrl: string }> {
  const address = await app.listen({ port, host: "127.0.0.1" });
  return { httpUrl: address, tunnelUrl: `${address.replace(/^http/, "ws")}/tunnel` };
}

// Every /relay/* request needs a signed-in relay account that has linked
// the server it names (routes/relay.ts). Signing in for real means a live
// OAuth round trip, so specs make the account and session straight in the
// db and get back a Cookie header any fetch() can reuse.
let signInCounter = 0;
export function signIn(db: Database): { userId: number; cookieHeader: string; token: string } {
  signInCounter += 1;
  const user = upsertUser(db, "google", {
    providerUserId: `test-user-${signInCounter}`,
    email: "test@example.com",
    displayName: "Test User",
    avatarUrl: null,
  });
  const { token } = createSession(db, user.id);
  return { userId: user.id, cookieHeader: `relay_session=${token}`, token };
}
