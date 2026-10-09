import { randomUUID } from "node:crypto";
import type { Database } from "../sqlite.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserBySessionToken, SESSION_COOKIE } from "../accounts.js";
import { sanitizeHeaders } from "../headers.js";
import { clientAddress } from "../rate-limit.js";
import { isLinkedServer } from "../linked-servers.js";
import type { RequestFrame } from "../protocol.js";
import { SERVER_ID_PATTERN } from "../signing-keys.js";
import type { TunnelRegistry } from "../tunnel-registry.js";

// ADDRESSING: which tunnel does a /relay/* request go to?
//
// The server's id is the first path segment: /relay/<server id>/api/v1/…
// reaches that server's /api/v1/…. An account can link several servers
// (issue #310), each with a tunnel of its own (tunnel-registry.ts), so the
// account alone can't say which one is meant.
//
// Who may use it: a caller signed in to a relay account the same way as
// everything under /auth and /pair, with the relay_session cookie
// routes/auth.ts sets, whose account has linked that server
// (linked_servers, migration 0005). That's the same pair POST
// /auth/server-token checks before it signs an `access` token for a
// server, so the relay carries requests exactly where legato.fm already
// vouches for the account. An id the account hasn't linked is a 404 whether
// or not that server is connected: the answer says nothing about servers
// that aren't the caller's.
//
// Cookies stay on this side. legato.fm's own cookies (the relay session
// among them) are never sent down a tunnel, and a home server's Set-Cookie
// never comes back up one: every server shares this one origin, so a
// cookie one server set here would be sent to all the others, and could
// replace the caller's legato.fm session. Home servers don't need either:
// clients send them a bearer token, and a media ticket in the URL
// (server/src/auth/gate.ts).
//
// No script runs on this origin. A server's responses are served from
// legato.fm's own origin, where a same-origin request carries the
// relay_session cookie: a page a home server sent here could call POST
// /auth/server-token or DELETE /linked-servers as whoever opened it. So
// every /relay/* response, the relay's own refusals included, carries
// `Content-Security-Policy: sandbox`, which opens a document in an opaque
// origin with no script and no forms, and `X-Content-Type-Options:
// nosniff`, so a body is only ever what its Content-Type says. A server's
// own policy is kept beside it, and can only narrow it. fetch(), <img> and
// <audio> don't read either header, so clients are unaffected. Giving each
// server an origin of its own would make the sandbox unnecessary.
// The largest request body the relay carries to a home server. A body is
// held whole in memory and goes down the tunnel as one base64 frame, so it
// can't be unlimited. The biggest one any Legato client sends is a first
// map settle (PUT /layout/settled), which the server itself caps at 4 MiB;
// a playlist import stays under the server's 1 MiB default.
export const REQUEST_BODY_LIMIT = 4 * 1024 * 1024;

export function relayRoutes(registry: TunnelRegistry, db: Database) {
  return async function routes(app: FastifyInstance) {
    // On the raw response, so it holds for replies Fastify sends (a 401,
    // a 413) and for the hijacked ones below alike.
    app.addHook("onRequest", async (_request, reply) => {
      reply.raw.setHeader("content-security-policy", SANDBOX);
      reply.raw.setHeader("x-content-type-options", "nosniff");
    });

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
    //
    // parseAs "buffer" is what makes Fastify hold a body to bodyLimit and
    // answer 413 past it; a parser that reads the stream itself is never
    // held to any limit.
    const rawBody = { parseAs: "buffer" as const, bodyLimit: REQUEST_BODY_LIMIT };
    const passThrough = (_req: unknown, body: Buffer | string, done: (err: Error | null, body?: Buffer | string) => void) =>
      done(null, body);
    app.addContentTypeParser("*", rawBody, passThrough);
    app.addContentTypeParser("application/json", rawBody, passThrough);
    app.addContentTypeParser("text/plain", rawBody, passThrough);

    const forward = async (request: FastifyRequest<{ Params: { serverId: string } }>, reply: FastifyReply) => {
      const token = request.cookies[SESSION_COOKIE];
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401).send({ error: "sign in first" });
        return;
      }

      const { serverId } = request.params;
      if (!SERVER_ID_PATTERN.test(serverId) || !isLinkedServer(db, user.id, serverId)) {
        reply.code(404).send({ error: "no server with that id is linked to this account" });
        return;
      }

      const tunnel = registry.get(serverId);
      if (!tunnel) {
        reply.code(503).send({ error: "that server isn't connected to legato.fm right now" });
        return;
      }

      const requestId = randomUUID();
      const targetPath = pathOnServer(request.url);
      const bodyBuffer = request.body instanceof Buffer ? request.body : undefined;
      const headers = sanitizeHeaders(request.headers);
      delete headers.cookie;

      const frame: RequestFrame = {
        type: "request",
        requestId,
        method: request.method,
        path: targetPath,
        headers,
        ...(bodyBuffer && bodyBuffer.length > 0 ? { body: bodyBuffer.toString("base64") } : {}),
        clientAddress: clientAddress(request.headers, request.ip),
      };

      // Fastify would otherwise manage (and buffer) the reply itself; hijack
      // hands the raw Node ServerResponse to us so writes actually flush
      // onto the socket as response-chunk frames arrive, not after the
      // route handler returns.
      reply.hijack();

      await new Promise<void>((resolve) => {
        registry.registerPending(requestId, tunnel.socket, request.method, {
          // Flushed at once, so the device has the status while the body
          // is still on its way, and so a failure after it can only break
          // the connection off (onError).
          onStart: (status, responseHeaders) => {
            reply.raw.writeHead(status, forDevice(responseHeaders));
            reply.raw.flushHeaders();
          },
          onChunk: (buf) => {
            reply.raw.write(buf);
          },
          onEnd: () => {
            reply.raw.end();
            resolve();
          },
          // Once the status has gone out, a failure breaks the connection
          // off rather than ending the body cleanly: a cut-short stream
          // must not look like a whole one.
          onError: (message) => {
            if (!reply.raw.headersSent) {
              reply.raw.writeHead(502, { "content-type": "application/json" });
              reply.raw.end(JSON.stringify({ error: message }));
            } else {
              reply.raw.destroy();
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

        registry.sendRequest(tunnel.socket, frame);
      });
    };

    app.all("/relay/:serverId", forward);
    app.all("/relay/:serverId/*", forward);
  };
}

// The path the device asked for past /relay/<id>, with its query, exactly
// as it sent it: cut at the end of the raw id segment. The decoded id
// can't be used to measure it, since a percent-encoded id is longer on
// the wire than once decoded.
const AFTER_ID = /^\/[^/?]*\/[^/?]*(.*)$/s;

function pathOnServer(url: string): string {
  const rest = AFTER_ID.exec(url)?.[1] ?? "";
  return rest.startsWith("/") ? rest : `/${rest}`;
}

const SANDBOX = "sandbox";

// The only headers a home server's answer takes to the device: what its
// own routes send through the relay. The body's type, length and range
// (routes/files.ts), caching (covers, the stream cache, the web client),
// the Vary @fastify/cors adds, a cover's source, and the sign-in
// limiter's Retry-After. A header a server route starts sending later
// needs adding here.
//
// Everything else stays on the server's side, because the answer lands on
// legato.fm's origin. Set-Cookie and Clear-Site-Data would change
// legato.fm's own cookies and storage, the relay session among them. A
// Location or Refresh would make auth.legato.fm an open redirect, and a
// Legato server never redirects anywhere through the relay: its only
// redirects are to Google and GitHub for its own sign-in. And CORS headers
// would let a server decide who may read legato.fm's answers.
const DEVICE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "vary",
  "x-cover-source",
  "retry-after",
  "content-security-policy",
]);

// A home server's response headers as they go to the device: only those
// above, and the sandbox kept whatever the server sent. writeHead()'s
// headers win over setHeader()'s, so a server's own policy goes out next
// to the sandbox (both are enforced). The relay's X-Content-Type-Options
// is the only one.
function forDevice(headers: Record<string, string>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!DEVICE_HEADERS.has(key)) continue;
    result[key] = key === "content-security-policy" ? [value, SANDBOX] : value;
  }
  return result;
}
