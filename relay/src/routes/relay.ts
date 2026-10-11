import { randomUUID } from "node:crypto";
import type { Database } from "../sqlite.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserBySessionToken, SESSION_COOKIE } from "../accounts.js";
import { sanitizeHeaders } from "../headers.js";
import { clientAddress } from "../rate-limit.js";
import { isLinkedServer } from "../linked-servers.js";
import type { RequestFrame } from "../protocol.js";
import { SERVER_ID_PATTERN, verifyRelayTicket, type SigningKeys } from "../signing-keys.js";
import type { TunnelRegistry } from "../tunnel-registry.js";
import { isLegatoClientOrigin } from "./auth.js";

// ADDRESSING: which tunnel does a /relay/* request go to?
//
// The server's id is the first path segment: /relay/<server id>/api/v1/…
// reaches that server's /api/v1/…. An account can link several servers
// (issue #310), each with a tunnel of its own (tunnel-registry.ts), so the
// account alone can't say which one is meant.
//
// Who may use it: an account that has linked that server (linked_servers,
// migration 0005), checked on every request. That's the same pair POST
// /auth/server-token checks before it signs an `access` token for a
// server, so the relay carries requests exactly where legato.fm already
// vouches for the account, and unlinking stops a device at its next
// request. An id the account hasn't linked is a 404 whether or not that
// server is connected: the answer says nothing about servers that aren't
// the caller's.
//
// A device says which account it is with a relay ticket (issue #365,
// signing-keys.ts) for that server: in the X-Legato-Relay header, or, for
// what can't send a header (<img>, <audio>, the event stream), a `relay`
// query parameter. A browser tab on legato.fm itself can still use the
// relay_session cookie routes/auth.ts sets. The ticket is the relay's
// alone: it's taken off before the request goes down the tunnel, so a home
// server never sees it. The home server checks its own credential, which
// the device sends beside the ticket as it would at home.
//
// Legato's own clients call this cross-origin: the desktop webview, a
// loopback dev page, and a web client a home server served, while it holds
// a live web session for this server (isLegatoClientOrigin in
// routes/auth.ts, issue #365). The relay answers their CORS itself,
// preflights included, and never with Access-Control-Allow-Credentials, so
// no cookie of legato.fm's is ever sent or read cross-site.
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

export function relayRoutes(
  registry: TunnelRegistry,
  db: Database,
  options: { signingKeys: SigningKeys | null; issuer: string | undefined },
) {
  const { signingKeys, issuer } = options;

  // The account a request's credential belongs to: its relay ticket's, if it
  // brought one, which has to be good for this server; otherwise its
  // relay_session cookie's. Null when neither holds.
  const accountFor = (request: FastifyRequest, serverId: string): number | null => {
    const ticket = relayTicket(request);
    if (ticket !== null) {
      if (!signingKeys || !issuer) return null;
      return verifyRelayTicket(signingKeys, ticket, { issuer, serverId })?.accountId ?? null;
    }
    const token = request.cookies[SESSION_COOKIE];
    return (token ? getUserBySessionToken(db, token) : null)?.id ?? null;
  };

  return async function routes(app: FastifyInstance) {
    // On the raw response, so it holds for replies Fastify sends (a 401,
    // a 413) and for the hijacked ones below alike.
    app.addHook("onRequest", async (request, reply) => {
      reply.raw.setHeader("content-security-policy", SANDBOX);
      reply.raw.setHeader("x-content-type-options", "nosniff");
      reply.raw.setHeader("vary", "Origin");
      const origin = request.headers.origin;
      const { serverId } = request.params as { serverId?: string };
      if (!isLegatoClientOrigin(db, signingKeys, origin, serverId)) return;
      reply.raw.setHeader("access-control-allow-origin", origin);
      reply.raw.setHeader("access-control-expose-headers", EXPOSED_HEADERS);
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
      // A CORS preflight carries no credentials, so the relay answers it
      // itself, for every origin the hook above allows, and it never
      // reaches a home server.
      if (request.method === "OPTIONS") {
        if (reply.raw.hasHeader("access-control-allow-origin")) {
          reply.raw.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE");
          reply.raw.setHeader("access-control-allow-headers", "Authorization, Content-Type, Range, X-Legato-Relay");
          reply.raw.setHeader("access-control-max-age", "600");
        }
        reply.code(204).send();
        return;
      }

      const { serverId } = request.params;
      const accountId = accountFor(request, serverId);
      if (accountId === null) {
        reply
          .code(401)
          .send({ error: "Sign in to legato.fm first, or get a fresh relay ticket for this server.", reason: "relay_signed_out" });
        return;
      }
      if (!SERVER_ID_PATTERN.test(serverId) || !isLinkedServer(db, accountId, serverId)) {
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
      delete headers[TICKET_HEADER];

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
  const rest = withoutTicket(AFTER_ID.exec(url)?.[1] ?? "");
  return rest.startsWith("/") ? rest : `/${rest}`;
}

const TICKET_HEADER = "x-legato-relay";
const TICKET_PARAM = "relay";

function relayTicket(request: FastifyRequest): string | null {
  const header = request.headers[TICKET_HEADER];
  if (typeof header === "string" && header) return header;
  const param = (request.query as Record<string, unknown> | undefined)?.[TICKET_PARAM];
  return typeof param === "string" && param ? param : null;
}

// The query string with the relay ticket taken out, and every other
// parameter left exactly as the device encoded it. A ticket is base64url
// and dots, so it never needs decoding to be recognised.
function withoutTicket(pathAndQuery: string): string {
  const at = pathAndQuery.indexOf("?");
  if (at < 0) return pathAndQuery;
  const kept = pathAndQuery
    .slice(at + 1)
    .split("&")
    .filter((part) => part.split("=", 1)[0] !== TICKET_PARAM);
  return kept.length ? `${pathAndQuery.slice(0, at)}?${kept.join("&")}` : pathAndQuery.slice(0, at);
}

// For the relay's own request log (app.ts): a relay ticket, and a home
// server's media ticket (server/src/auth/gate.ts), both ride in /relay/*
// query strings. Replaces just the values.
export function redactCredentials(url: string): string {
  return url.replace(/([?&](?:relay|t)=)[^&]*/g, "$1[redacted]");
}

// What a cross-origin client may read beyond the CORS-safelisted headers:
// the ones a client reads off a home server's answer (DEVICE_HEADERS
// below), and the sign-in limiter's Retry-After.
const EXPOSED_HEADERS = "Content-Range, Accept-Ranges, ETag, Retry-After, X-Cover-Source";

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
  // The relay's answer depends on the Origin it was asked from (its CORS
  // headers), so a server's own Vary keeps Origin beside it.
  if (typeof result.vary === "string" && !/(^|,)\s*origin\s*(,|$)/i.test(result.vary)) result.vary = `${result.vary}, Origin`;
  return result;
}
