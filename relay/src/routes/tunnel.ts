import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { tunnelCredentialHolder } from "../pairing.js";
import { parseFrame } from "../protocol.js";
import type { Tunnel, TunnelRegistry } from "../tunnel-registry.js";

const AUTH_TIMEOUT_MS = 5000;

// The home server reads auth-error as "stop trying" (server/src/tunnel/
// client.ts), so it's only sent when the credential itself is the problem.
const INVALID_CREDENTIAL = "missing or invalid tunnel credential";
const UNBOUND_CREDENTIAL = "this tunnel credential isn't bound to a server; link the server to legato.fm again";

function refuse(socket: WebSocket, message: string): void {
  socket.send(JSON.stringify({ type: "auth-error", message }));
  socket.close(4001, message.slice(0, 120));
}

// The home server's side of the tunnel: one persistent inbound WebSocket
// per home server, opened by its tunnel client (server/src/tunnel/) and
// authenticated with the tunnel credential legato.fm minted when the
// server reported its link (linked-servers.ts, acceptLinkProof). That
// credential is bound to the server's id (migration 0006), and the id is
// what the tunnel is registered under (tunnel-registry.ts). One account's
// servers each keep their own tunnel.
export function tunnelRoutes(registry: TunnelRegistry, db: Database) {
  return async function routes(app: FastifyInstance) {
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
          tunnel = { socket, serverId: holder.serverId };
          registry.set(tunnel);
          socket.send(JSON.stringify({ type: "auth-ok" }));
          return;
        }

        registry.handleFrame(socket, frame);
      });

      socket.on("close", () => {
        clearTimeout(authTimeout);
        if (tunnel) registry.drop(tunnel.serverId, socket);
      });
    });
  };
}
