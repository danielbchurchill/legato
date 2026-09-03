import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getUserBySessionToken, SESSION_COOKIE } from "../accounts.js";
import { sanitizeHeaders } from "../headers.js";
import type { RequestFrame } from "../protocol.js";
import type { TunnelRegistry } from "../tunnel-registry.js";

// ADDRESSING: which tenant's tunnel does a /relay/* request go to?
//
// No account identifier ever appears in the URL. A caller hitting
// /relay/* is expected to already be signed into a relay account the
// same way as everything under /auth and /pair — the relay_session
// cookie set by routes/auth.ts's OAuth callback. That session already
// names a relay_user_id, so "route this request to MY paired home
// server" is exactly registry.getTunnel(that relay_user_id): no separate
// lookup, no id to leak into logs/URLs/browser history, and no
// authorization check to get right because there's no id in the request
// for a caller to substitute someone else's account into.
//
// The alternative considered was an explicit account/device id in the
// path or a header (`/relay/:accountId/*`), rejected because it turns
// "does this request reach the right tunnel" into "does this request
// reach a tunnel this caller is *authorized* to reach" — an extra check
// that's trivial to get right today and easy to get wrong later. The
// session-derived approach makes it a non-question instead. It also
// composes for free with a future "more than one paired home server per
// account": getTunnel would just take a second argument then (which
// paired server) — today it's a 1:1 account:tunnel map, see
// tunnel-registry.ts.
export function relayRoutes(registry: TunnelRegistry, db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    // Scoped to this plugin only — not the root app — so /auth/* and
    // /pair/* keep Fastify's normal JSON body parsing. Every byte of
    // every /relay/* request body just needs to reach the home server
    // unmodified, but a bare `*` wildcard parser is NOT enough to
    // guarantee that: Fastify's own built-in default parsers for
    // `application/json` and `text/plain` take precedence over a custom
    // `*` parser regardless of registration order (confirmed empirically
    // against fastify@5.12.0; not called out anywhere obvious in its
    // docs). Without registering those two content types explicitly
    // here, a mobile client's JSON POST/PATCH body — the common case for
    // the home server's REST API — would get silently parsed into a JS
    // object by Fastify's default parser and then dropped entirely by
    // the `instanceof Buffer` check below, forwarding an empty body to
    // the home server instead of the real one.
    const rawBody = (
      _req: unknown,
      payload: NodeJS.ReadableStream,
      done: (err: Error | null, body?: Buffer) => void,
    ) => {
      const chunks: Buffer[] = [];
      payload.on("data", (chunk: Buffer) => chunks.push(chunk));
      payload.on("end", () => done(null, Buffer.concat(chunks)));
      payload.on("error", (err: Error) => done(err, undefined));
    };
    app.addContentTypeParser("*", rawBody);
    app.addContentTypeParser("application/json", rawBody);
    app.addContentTypeParser("text/plain", rawBody);

    app.all("/relay/*", async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401).send({ error: "sign in first" });
        return;
      }

      const tunnel = registry.getTunnel(user.id);
      if (!tunnel) {
        reply.code(503).send({ error: "no home server tunnel connected for this account" });
        return;
      }

      const requestId = randomUUID();
      const targetPath = request.url.slice("/relay".length) || "/";
      const bodyBuffer = request.body instanceof Buffer ? request.body : undefined;

      const frame: RequestFrame = {
        type: "request",
        requestId,
        method: request.method,
        path: targetPath,
        headers: sanitizeHeaders(request.headers),
        ...(bodyBuffer && bodyBuffer.length > 0 ? { body: bodyBuffer.toString("base64") } : {}),
      };

      // Fastify would otherwise manage (and buffer) the reply itself; hijack
      // hands the raw Node ServerResponse to us so writes actually flush
      // onto the socket as response-chunk frames arrive, not after the
      // route handler returns.
      reply.hijack();

      await new Promise<void>((resolve) => {
        registry.registerPending(requestId, user.id, {
          onStart: (status, headers) => {
            reply.raw.writeHead(status, headers);
          },
          onChunk: (buf) => {
            reply.raw.write(buf);
          },
          onEnd: () => {
            reply.raw.end();
            resolve();
          },
          onError: (message) => {
            if (!reply.raw.headersSent) {
              reply.raw.writeHead(502, { "content-type": "application/json" });
              reply.raw.end(JSON.stringify({ error: message }));
            } else {
              reply.raw.end();
            }
            resolve();
          },
        });

        // The response object's own 'close', not the request's: Node fires
        // `request.raw`'s 'close' as soon as the *request body* has been
        // fully read, which for any request with a body happens well
        // before a response exists — listening there would cancel this
        // request's slot instantly, before the home server ever gets to
        // answer. `reply.raw` closes only when the underlying connection
        // actually goes away, which is the real "mobile client hung up"
        // signal this is meant to catch; writableEnded distinguishes that
        // from the ordinary close after onEnd()/onError() above already
        // finished the response.
        reply.raw.on("close", () => {
          if (!reply.raw.writableEnded) registry.cancelPending(requestId);
        });

        registry.sendRequest(tunnel, frame);
      });
    });
  };
}
