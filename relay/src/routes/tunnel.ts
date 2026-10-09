import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { tunnelCredentialHolder } from "../pairing.js";
import { parseFrame } from "../protocol.js";
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

function markSeen(db: Database, serverIds: string[]): void {
  if (serverIds.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO server_tunnels (server_id, last_seen_at) VALUES (?, datetime('now'))
     ON CONFLICT (server_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  );
  db.transaction(() => {
    for (const serverId of serverIds) upsert.run(serverId);
  })();
}

function heartbeat(registry: TunnelRegistry, db: Database): void {
  const seen: string[] = [];
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
      seen.push(tunnel.serverId);
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

      socket.on("message", (raw: Buffer) => {
        const frame = parseFrame(raw.toString("utf8"));
        if (!frame) return;

        if (!tunnel) {
          clearTimeout(authTimeout);
          const credential = frame.type === "auth" && typeof frame.secret === "string" ? frame.secret : undefined;
          const holder = credential ? tunnelCredentialHolder(db, credential) : null;
          if (!credential || !holder) return refuse(socket, INVALID_CREDENTIAL);
          if (!holder.serverId) return refuse(socket, UNBOUND_CREDENTIAL);
          tunnel = { socket, serverId: holder.serverId, credential, connectedAt: new Date(), alive: true };
          registry.set(tunnel);
          markSeen(db, [tunnel.serverId]);
          socket.send(JSON.stringify({ type: "auth-ok" }));
          return;
        }

        tunnel.alive = true;
        registry.handleFrame(socket, frame);
      });

      socket.on("pong", () => {
        if (tunnel) tunnel.alive = true;
      });

      socket.on("close", () => {
        clearTimeout(authTimeout);
        if (!tunnel) return;
        registry.drop(tunnel.serverId, socket);
        markSeen(db, [tunnel.serverId]);
      });
    });
  };
}
