import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { tunnelCredentialHolder } from "../pairing.js";
import { parseFrame, type TunnelFrame } from "../protocol.js";
import type { Tunnel, TunnelRegistry } from "../tunnel-registry.js";

const AUTH_TIMEOUT_MS = 5000;

// How often the relay pings every tunnel, checks its credential again, and
// notes that it's still there (migration 0007). A tunnel that misses one
// pong is dropped at the next beat, so a server that lost power or its
// network shows as offline within a minute, not when TCP gives up hours
// later.
export const HEARTBEAT_MS = 30_000;

// The home server reads auth-error as "stop trying" (server/src/tunnel/
// client.ts), so it's only sent when the credential itself is the problem.
const INVALID_CREDENTIAL = "missing or invalid tunnel credential";
const UNBOUND_CREDENTIAL = "this tunnel credential isn't bound to a server; link the server to legato.fm again";
const CREDENTIAL_ENDED = "this tunnel credential was revoked or has expired";

function refuse(socket: WebSocket, message: string): void {
  socket.send(JSON.stringify({ type: "auth-error", message }));
  socket.close(4001, message.slice(0, 120));
}

// Who a new tunnel's first frame says it is: the server its credential was
// minted for, or why it's refused. The one place a tunnel's credential is
// looked up when it signs in.
function signIn(db: Database, frame: TunnelFrame): { serverId: string; credential: string } | { refused: string } {
  const credential = frame.type === "auth" && typeof frame.secret === "string" ? frame.secret : undefined;
  const holder = credential ? tunnelCredentialHolder(db, credential) : null;
  if (!credential || !holder) return { refused: INVALID_CREDENTIAL };
  if (!holder.serverId) return { refused: UNBOUND_CREDENTIAL };
  return { serverId: holder.serverId, credential };
}

// Writes when legato.fm last heard from each tunnel: its last frame or
// pong, not the moment the relay wrote it down or gave up on it. A server
// that lost power is dropped a beat or two later, and "offline since"
// should still say when it went quiet.
function markSeen(db: Database, tunnels: Tunnel[]): void {
  if (tunnels.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO server_tunnels (server_id, last_seen_at) VALUES (?, datetime(?, 'unixepoch'))
     ON CONFLICT (server_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  );
  db.transaction(() => {
    for (const tunnel of tunnels) upsert.run(tunnel.serverId, Math.floor(tunnel.lastHeardAt.getTime() / 1000));
  })();
}

function heartbeat(registry: TunnelRegistry, db: Database): void {
  const seen: Tunnel[] = [];
  for (const tunnel of registry.all()) {
    if (tunnelCredentialHolder(db, tunnel.credential)?.serverId !== tunnel.serverId) {
      registry.drop(tunnel.serverId, tunnel.socket);
      refuse(tunnel.socket, CREDENTIAL_ENDED);
    } else if (!tunnel.alive) {
      registry.drop(tunnel.serverId, tunnel.socket);
      tunnel.socket.terminate();
    } else {
      tunnel.alive = false;
      tunnel.socket.ping();
      seen.push(tunnel);
    }
  }
  markSeen(db, seen);
}

// The home server's side of the tunnel: one persistent inbound WebSocket
// per home server, opened by its tunnel client (server/src/tunnel/) and
// authenticated with the tunnel credential legato.fm minted when the
// server reported its link (linked-servers.ts, acceptLinkProof). That
// credential is bound to the server's id (migration 0006), and the id is
// what the tunnel is registered under (tunnel-registry.ts). One account's
// servers each keep their own tunnel.
export function tunnelRoutes(registry: TunnelRegistry, db: Database, options: { heartbeatMs?: number } = {}) {
  return async function routes(app: FastifyInstance) {
    const beat = setInterval(() => heartbeat(registry, db), options.heartbeatMs ?? HEARTBEAT_MS);
    beat.unref?.();
    app.addHook("onClose", async () => clearInterval(beat));

    app.get("/tunnel", { websocket: true }, (socket: WebSocket) => {
      let tunnel: Tunnel | undefined;

      // A socket that connects but never sends an auth frame (dead client,
      // firewall half-open, etc.) would otherwise sit forever without ever
      // becoming a usable tunnel or freeing its slot.
      const authTimeout = setTimeout(() => {
        if (!tunnel) socket.close(4001, "auth timeout");
      }, AUTH_TIMEOUT_MS);

      // Whatever a frame holds, nothing it does may throw out of this
      // listener: an exception here would take down the relay, and every
      // other server's tunnel with it. A tunnel whose frames are hostile
      // (tunnel-registry.ts) is closed, and so is one that makes this
      // listener throw; a genuine server reconnects through its backoff.
      let closing = false;
      const close = (code: number, reason: string) => {
        closing = true;
        if (tunnel) registry.drop(tunnel.serverId, socket);
        socket.close(code, reason);
      };

      socket.on("message", (raw: Buffer) => {
        if (closing) return;
        try {
          const frame = parseFrame(raw.toString("utf8"));
          if (!frame) return;

          if (!tunnel) {
            clearTimeout(authTimeout);
            const signedIn = signIn(db, frame);
            if ("refused" in signedIn) return refuse(socket, signedIn.refused);
            const now = new Date();
            tunnel = { socket, ...signedIn, connectedAt: now, lastHeardAt: now, alive: true };
            registry.set(tunnel);
            markSeen(db, [tunnel]);
            socket.send(JSON.stringify({ type: "auth-ok" }));
            return;
          }

          tunnel.alive = true;
          tunnel.lastHeardAt = new Date();
          if (registry.handleFrame(socket, frame) === "hostile") close(4002, "sent a frame no Legato server sends");
        } catch (err) {
          app.log.warn(`tunnel: closed a connection whose frame couldn't be handled: ${err instanceof Error ? err.message : String(err)}`);
          close(1011, "couldn't handle a frame");
        }
      });

      socket.on("pong", () => {
        if (!tunnel) return;
        tunnel.alive = true;
        tunnel.lastHeardAt = new Date();
      });

      socket.on("close", () => {
        clearTimeout(authTimeout);
        if (!tunnel) return;
        registry.drop(tunnel.serverId, socket);
        markSeen(db, [tunnel]);
      });
    });
  };
}
