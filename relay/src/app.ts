import websocketPlugin from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { relayRoutes } from "./routes/relay.js";
import { tunnelRoutes } from "./routes/tunnel.js";
import { TunnelRegistry } from "./tunnel-registry.js";

export interface BuildAppOptions {
  sharedSecret: string;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const registry = new TunnelRegistry();

  // This service has no JSON API of its own to parse — every byte of every
  // /relay/* request body just needs to reach the home server unmodified.
  // Capturing it as a raw Buffer regardless of Content-Type, instead of
  // registering per-type parsers, keeps the proxy content-agnostic on purpose.
  app.addContentTypeParser("*", (_req, payload, done) => {
    const chunks: Buffer[] = [];
    payload.on("data", (chunk: Buffer) => chunks.push(chunk));
    payload.on("end", () => done(null, Buffer.concat(chunks)));
    payload.on("error", (err: Error) => done(err, undefined));
  });

  app.register(websocketPlugin);
  app.register(tunnelRoutes(registry, options.sharedSecret));
  app.register(relayRoutes(registry));

  return app;
}
