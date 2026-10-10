import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
import { linkProof, serverIdForPublicKey, unlinkProof, type ServerKey } from "../../server/src/auth/serverKey.js";
import type { TunnelClient } from "../../server/src/tunnel/client.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { isLinkedServer } from "./linked-servers.js";
import { tunnelCredentialHolder } from "./pairing.js";
import { parseSigningKeys } from "./signing-keys.js";
import type { Database } from "./sqlite.js";
import { sleep, startFixtureServer, type FixtureServerHandle } from "./testing/fixture-http-server.js";
import { connectHomeServer, listenApp, signIn, waitForState } from "./testing/tunnel-harness.js";

// Issue #325's review: a tunnel credential's life across a server's links,
// with every link a real signed report (POST /linked-servers) and every
// tunnel the home server's own client. Minting retires nothing; the new
// credential's first sign-in retires the server's earlier ones, under any
// account (pairing.ts); unlinking takes the pair's credential with it
// (linked-servers.ts).

const ISSUER = "https://auth.legato.test";
const HEARTBEAT_MS = 50;

function homeServerKey(): ServerKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;
  return { serverId: serverIdForPublicKey(publicKey), publicKey, privateKey };
}

describe("tunnel credentials across a server's links", () => {
  let db: Database;
  let app: FastifyInstance;
  let httpUrl: string;
  let tunnelUrl: string;
  let fixture: FixtureServerHandle;
  let clients: TunnelClient[] = [];

  beforeEach(async () => {
    db = openDb(":memory:");
    fixture = await startFixtureServer((req, res) => res.end(`home ${req.url}`));
    const { privateKey } = generateKeyPairSync("ed25519");
    const signingKeys = parseSigningKeys(JSON.stringify([{ privateKey: privateKey.export({ format: "pem", type: "pkcs8" }) }]));
    app = buildApp({ db, tunnelHeartbeatMs: HEARTBEAT_MS, auth: { config: { callbackBaseUrl: ISSUER }, signingKeys } });
    ({ httpUrl, tunnelUrl } = await listenApp(app));
  });

  afterEach(async () => {
    for (const client of clients) client.stop();
    clients = [];
    await app.close();
    await fixture.close();
  });

  // The whole link as a server makes it: a link token from the account's
  // session, and the server's signed report of it. Returns the credential
  // the report's answer carries.
  async function link(account: { token: string }, server: ServerKey): Promise<string> {
    const headers = { authorization: `Bearer ${account.token}` };
    const issued = await app.inject({
      method: "POST",
      url: "/auth/server-token",
      headers,
      payload: { serverId: server.serverId, scope: "link" },
    });
    const report = await app.inject({
      method: "POST",
      url: "/linked-servers",
      payload: linkProof(server, (issued.json() as { token: string }).token),
    });
    expect(report.statusCode).toBe(200);
    return (report.json() as { tunnel: { credential: string } }).tunnel.credential;
  }

  async function connect(credential: string): Promise<TunnelClient> {
    const client = await connectHomeServer({ tunnelUrl, credential, targetBaseUrl: fixture.url, log: () => {} });
    clients.push(client);
    return client;
  }

  // One sign-in by hand: what a copy of a credential gets.
  function signInOnce(credential: string): Promise<"ok" | string> {
    const socket = new WebSocket(tunnelUrl);
    return new Promise((resolve) => {
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", secret: credential })));
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as { type: string; message?: string };
        if (frame.type === "auth-ok") resolve("ok");
        if (frame.type === "auth-error") resolve(frame.message ?? "auth-error");
        socket.close();
      });
    });
  }

  async function reach(account: { cookieHeader: string }, server: ServerKey): Promise<string> {
    const response = await fetch(`${httpUrl}/relay/${server.serverId}/x`, { headers: { cookie: account.cookieHeader } });
    return `${response.status} ${await response.text()}`;
  }

  it("keeps the old credential working when a link's answer never reaches the server", async () => {
    const owner = signIn(db);
    const server = homeServerKey();
    const first = await link(owner, server);
    const client = await connect(first);

    // Linked again, but the answer is lost: the server goes on with the
    // credential it has, and reconnects with it.
    const lost = await link(owner, server);
    client.stop();
    await connect(first);
    await sleep(HEARTBEAT_MS * 4);
    expect(clients.at(-1)!.state).toBe("connected");
    expect(await reach(owner, server)).toBe("200 home /x");
    // The old one reconnecting didn't retire the newer one either.
    expect(tunnelCredentialHolder(db, lost)).not.toBeNull();
  });

  it("retires the old credential the first time the new one signs in, and refuses a copy of it after", async () => {
    const owner = signIn(db);
    const server = homeServerKey();
    const first = await link(owner, server);
    const client = await connect(first);

    const second = await link(owner, server);
    expect(tunnelCredentialHolder(db, first)).not.toBeNull();
    // What the server does once the link's answer has gone (server/src/
    // tunnel/relayTunnel.ts): stop the old client, start one on the new.
    client.stop();
    await connect(second);
    expect(tunnelCredentialHolder(db, first)).toBeNull();
    expect(await signInOnce(first)).toBe("missing or invalid tunnel credential");
    expect(await reach(owner, server)).toBe("200 home /x");
  });

  it("lets an older credential sign in without retiring a newer one the server hasn't connected with yet", async () => {
    const owner = signIn(db);
    const server = homeServerKey();
    const first = await link(owner, server);
    const second = await link(owner, server);

    expect(await signInOnce(first)).toBe("ok");
    expect(tunnelCredentialHolder(db, second)).not.toBeNull();
    await connect(second);
    expect(tunnelCredentialHolder(db, first)).toBeNull();
  });

  it("takes the credential with a signed unlink, and refuses the server's tunnel at the next heartbeat", async () => {
    const owner = signIn(db);
    const server = homeServerKey();
    const client = await connect(await link(owner, server));

    const unlinked = await app.inject({
      method: "POST",
      url: "/linked-servers/unlink",
      payload: unlinkProof(server, { issuer: ISSUER, accountId: String(owner.userId), nowSeconds: Math.floor(Date.now() / 1000) }),
    });
    expect(unlinked.json()).toEqual({ unlinked: true });
    await waitForState(client, "refused");
  });

  it("takes the credential when the account removes the server itself", async () => {
    const owner = signIn(db);
    const server = homeServerKey();
    const credential = await link(owner, server);
    const client = await connect(credential);

    const removed = await app.inject({
      method: "DELETE",
      url: `/linked-servers/${server.serverId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(removed.json()).toEqual({ unlinked: true });
    expect(tunnelCredentialHolder(db, credential)).toBeNull();
    await waitForState(client, "refused");
  });

  it("retires the first account's credential once a second account's, after a relink, signs in", async () => {
    const first = signIn(db);
    const second = signIn(db);
    const server = homeServerKey();
    const firstCredential = await link(first, server);
    const client = await connect(firstCredential);

    const secondCredential = await link(second, server);
    expect(tunnelCredentialHolder(db, firstCredential)).not.toBeNull();
    client.stop();
    await connect(secondCredential);
    expect(tunnelCredentialHolder(db, firstCredential)).toBeNull();
    expect(tunnelCredentialHolder(db, secondCredential)).toEqual({ relayUserId: second.userId, serverId: server.serverId });
    expect(await reach(second, server)).toBe("200 home /x");

    // The server then reports the first account unlinked
    // (server/src/auth/legatoLink.ts), and the tunnel stays up.
    await app.inject({
      method: "POST",
      url: "/linked-servers/unlink",
      payload: unlinkProof(server, { issuer: ISSUER, accountId: String(first.userId), nowSeconds: Math.floor(Date.now() / 1000) }),
    });
    expect(isLinkedServer(db, first.userId, server.serverId)).toBe(false);
    await sleep(HEARTBEAT_MS * 4);
    expect(clients.at(-1)!.state).toBe("connected");
  });
});
