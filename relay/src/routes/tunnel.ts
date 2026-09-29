import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { getRelayUserIdByCredential } from "../pairing.js";
import { parseFrame } from "../protocol.js";
import type { TunnelRegistry } from "../tunnel-registry.js";

const AUTH_TIMEOUT_MS = 5000;

// The home server's side of the tunnel: one persistent inbound WebSocket
// per home server, authenticated against a per-account tunnel credential
// (minted via POST /pair/exchange — see pairing.ts and migrations/
// 0002_tunnel_credentials.sql) rather than this prototype's original
// single global RELAY_SHARED_SECRET. Multiple home servers, each owned
// by a different relay account, can be authenticated and connected at
// once — see tunnel-registry.ts, now a map keyed by relay_user_id.
export function tunnelRoutes(registry: TunnelRegistry, db: Database) {
  return async function routes(app: FastifyInstance) {
    app.get("/tunnel", { websocket: true }, (socket: WebSocket) => {
      let authenticated = false;
      let relayUserId: number | undefined;

      // A socket that connects but never sends an auth frame (dead client,
      // firewall half-open, etc.) would otherwise sit forever without ever
      // becoming a usable tunnel or freeing its slot.
      const authTimeout = setTimeout(() => {
        if (!authenticated) socket.close(4001, "auth timeout");
      }, AUTH_TIMEOUT_MS);

      socket.on("message", (raw: Buffer) => {
        const frame = parseFrame(raw.toString("utf8"));
        if (!frame) return;

        if (!authenticated) {
          clearTimeout(authTimeout);
          const credential = frame.type === "auth" ? frame.secret : undefined;
          const ownerId = credential ? getRelayUserIdByCredential(db, credential) : null;
          if (ownerId !== null) {
            authenticated = true;
            relayUserId = ownerId;
            registry.setTunnel(ownerId, socket);
            socket.send(JSON.stringify({ type: "auth-ok" }));
          } else {
            socket.send(JSON.stringify({ type: "auth-error", message: "missing or invalid tunnel credential" }));
            socket.close(4001, "missing or invalid tunnel credential");
          }
          return;
        }

        registry.handleFrame(frame);
      });

      socket.on("close", () => {
        clearTimeout(authTimeout);
        if (relayUserId !== undefined) registry.clearTunnel(relayUserId, socket);
      });
    });
  };
}
