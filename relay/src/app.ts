import cookie from "@fastify/cookie";
import websocketPlugin from "@fastify/websocket";
import type { Database } from "./sqlite.js";
import Fastify, { type FastifyInstance } from "fastify";
import { authRoutes, type AuthRoutesOptions } from "./routes/auth.js";
import { relayRoutes } from "./routes/relay.js";
import { tunnelRoutes } from "./routes/tunnel.js";
import { TunnelRegistry } from "./tunnel-registry.js";

export interface BuildAppOptions {
  db: Database;
  logger?: boolean;
  // Stubbed provider exchange and config for tests and the local
  // end-to-end harness; production leaves it unset and reads the env.
  auth?: AuthRoutesOptions;
  // How often the tunnel heartbeat runs (routes/tunnel.ts). Tests shorten it.
  tunnelHeartbeatMs?: number;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const registry = new TunnelRegistry();

  app.register(cookie);

  // Unauthenticated on purpose — this is what a platform health check hits,
  // and it has no reason to know about relay accounts or tunnel credentials.
  app.get("/health", async () => ({ status: "ok" }));

  app.register(websocketPlugin);
  app.register(tunnelRoutes(registry, options.db, { heartbeatMs: options.tunnelHeartbeatMs }));
  app.register(relayRoutes(registry, options.db));
  // Also registers the pairing, claim and linked-server routes, which need
  // the signing keys it resolves, and the tunnels for GET /linked-servers.
  app.register(authRoutes(options.db, { ...options.auth, tunnels: registry }));

  return app;
}
