import cookie from "@fastify/cookie";
import websocketPlugin from "@fastify/websocket";
import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { authRoutes } from "./routes/auth.js";
import { pairRoutes } from "./routes/pair.js";
import { relayRoutes } from "./routes/relay.js";
import { tunnelRoutes } from "./routes/tunnel.js";
import { TunnelRegistry } from "./tunnel-registry.js";

export interface BuildAppOptions {
  db: Database.Database;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const registry = new TunnelRegistry();

  app.register(cookie);
  app.register(websocketPlugin);
  app.register(tunnelRoutes(registry, options.db));
  app.register(relayRoutes(registry, options.db));
  app.register(authRoutes(options.db));
  app.register(pairRoutes(options.db));

  return app;
}
