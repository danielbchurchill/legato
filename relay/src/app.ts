import cookie from "@fastify/cookie";
import websocketPlugin from "@fastify/websocket";
import type { Database } from "./sqlite.js";
import Fastify, { type FastifyInstance } from "fastify";
import { hashSource } from "./csp.js";
import { RELAY_SIGNING_KEYS } from "./config.js";
import { clientAddress } from "./rate-limit.js";
import { authRoutes, ENV_CONFIG, SUCCESS_PAGE_STYLE, type AuthRoutesOptions } from "./routes/auth.js";
import { redactCredentials, relayRoutes } from "./routes/relay.js";
import { tunnelRoutes } from "./routes/tunnel.js";
import { parseSigningKeys, type SigningKeys } from "./signing-keys.js";
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

// Every HTML page this service sends has a Content-Security-Policy (issue
// #324). A page with its own inline script or style sets its own policy,
// naming them by hash or nonce, as /claim does. Any other page gets this
// one, so a page added later can't go out without a policy because nobody
// remembered to give it one. It runs and loads nothing, and styles nothing
// but the one <style> the sign-in success page paints ink's canvas with
// (#291), named by its hash.
export const DEFAULT_PAGE_CSP = [
  "default-src 'none'",
  `style-src ${hashSource(SUCCESS_PAGE_STYLE)}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function buildApp(options: BuildAppOptions): FastifyInstance {
  // Fastify's default request serializer, except the URL: a relay ticket
  // and a home server's media ticket ride in /relay/* query strings (issue
  // #365), and every cover through the relay would otherwise write both
  // into the log.
  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            req: (request) => ({
              method: request.method,
              url: redactCredentials(request.url),
              host: request.host,
              remoteAddress: clientAddress(request.headers, request.ip),
              remotePort: request.socket?.remotePort,
            }),
          },
        }
      : false,
  });
  const registry = new TunnelRegistry();

  // Resolved once, for both the routes that sign (routes/auth.ts) and the
  // relay that checks what they signed (routes/relay.ts). Undefined reads
  // RELAY_SIGNING_KEYS; null is "signing off". A bad secret is a log line
  // and signing off, so it can't stop sign-in itself from working.
  let signingKeys: SigningKeys | null = null;
  if (options.auth?.signingKeys !== undefined) {
    signingKeys = options.auth.signingKeys;
  } else {
    try {
      signingKeys = parseSigningKeys(RELAY_SIGNING_KEYS);
    } catch (err) {
      app.log.error(`${err instanceof Error ? err.message : String(err)} Server token signing is off until it's fixed.`);
    }
  }
  const issuer = (options.auth?.config ?? ENV_CONFIG).callbackBaseUrl;

  app.register(cookie);

  // Synchronous: it runs on every response, the JSON ones too, and an async
  // hook would cost each of them a promise to look at one header.
  app.addHook("onSend", (_request, reply, payload, done) => {
    const type = reply.getHeader("content-type");
    if (typeof type === "string" && type.startsWith("text/html") && !reply.hasHeader("content-security-policy")) {
      reply.header("Content-Security-Policy", DEFAULT_PAGE_CSP);
    }
    done(null, payload);
  });

  // Unauthenticated on purpose — this is what a platform health check hits,
  // and it has no reason to know about relay accounts or tunnel credentials.
  app.get("/health", async () => ({ status: "ok" }));

  app.register(websocketPlugin);
  app.register(tunnelRoutes(registry, options.db, { heartbeatMs: options.tunnelHeartbeatMs }));
  app.register(relayRoutes(registry, options.db, { signingKeys, issuer }));
  // Also registers the pairing, claim and linked-server routes, which need
  // the signing keys, and the tunnels for GET /linked-servers.
  app.register(authRoutes(options.db, { ...options.auth, signingKeys, tunnels: registry }));

  return app;
}
