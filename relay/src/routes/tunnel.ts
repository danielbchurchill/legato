import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { parseFrame } from "../protocol.js";
import type { TunnelRegistry } from "../tunnel-registry.js";

const AUTH_TIMEOUT_MS = 5000;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// The home server's side of the tunnel: one persistent inbound WebSocket
// per home server, gated by a shared secret (real per-account auth is the
// deliberately deferred follow-up — see Legato.md's "Relay architecture").
export function tunnelRoutes(registry: TunnelRegistry, sharedSecret: string) {
  return async function routes(app: FastifyInstance) {
    app.get("/tunnel", { websocket: true }, (socket: WebSocket) => {
      let authenticated = false;

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
          const providedSecret = frame.type === "auth" ? frame.secret : undefined;
          const ok = sharedSecret.length > 0 && providedSecret !== undefined && safeEqual(providedSecret, sharedSecret);
          if (ok) {
            authenticated = true;
            registry.setTunnel(socket);
            socket.send(JSON.stringify({ type: "auth-ok" }));
          } else {
            socket.send(JSON.stringify({ type: "auth-error", message: "missing or invalid shared secret" }));
            socket.close(4001, "missing or invalid shared secret");
          }
          return;
        }

        registry.handleFrame(frame);
      });

      socket.on("close", () => {
        clearTimeout(authTimeout);
        registry.clearTunnel(socket);
      });
    });
  };
}
