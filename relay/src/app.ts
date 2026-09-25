import cookie from "@fastify/cookie";
import websocketPlugin from "@fastify/websocket";
import type { Database } from "./sqlite.js";
import Fastify, { type FastifyInstance } from "fastify";
import { authRoutes } from "./routes/auth.js";
import { pairRoutes } from "./routes/pair.js";
import { relayRoutes } from "./routes/relay.js";
import { tunnelRoutes } from "./routes/tunnel.js";
import { TunnelRegistry } from "./tunnel-registry.js";

export interface BuildAppOptions {
  db: Database;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const registry = new TunnelRegistry();

  app.register(cookie);

  // Unauthenticated on purpose — this is what a platform health check hits,
  // and it has no reason to know about relay accounts or tunnel credentials.
  app.get("/health", async () => ({ status: "ok" }));

  app.register(websocketPlugin);
  app.register(tunnelRoutes(registry, options.db));
  app.register(relayRoutes(registry, options.db));
  app.register(authRoutes(options.db));
  app.register(pairRoutes(options.db));

  return app;
}
