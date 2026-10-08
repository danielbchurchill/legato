import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "../sqlite.js";
import { legatoIdentity } from "./legatoIdentity.js";
import { looksLikeJws, VERIFY_FAILURE_MESSAGES, type LegatoClaims } from "./legatoToken.js";
import { anyLinkedAccount, userForLegatoClaims } from "./legatoUsers.js";
import { ownerExists } from "./owner.js";
import { userForMediaTicket, userForSessionToken, type SessionUser } from "./sessions.js";

// The owner gate (issue #112). Deny by default: one root-level onRequest
// hook, so a route added tomorrow is gated without anyone remembering to
// do it. gate.spec.ts enumerates every registered route to hold that line.
//
// Three credentials, checked in this order:
//   1. Authorization: Bearer <session token>, or Bearer <legato.fm token>
//      (issue #114): a signed JWS, told apart by its two dots, verified
//      against legato.fm's cached keys and mapped to a users row by
//      legato_account_id. What every fetch() sends.
//      The only one that works for the desktop app talking to the Pi over
//      plain http on a Tailscale IP, or the packaged app's tauri://localhost
//      page talking to 127.0.0.1: both are cross-site, and without TLS a
//      cookie can't be SameSite=None.
//   2. The legato_session cookie (HttpOnly, SameSite=Lax). Covers the
//      same-origin web client (#116) and the Google/GitHub popup, which
//      only has a cookie to hand back.
//   3. ?t=<media ticket>, GET/HEAD only — <img>, <audio> and the WebSocket
//      upgrade can't set a header. A ticket can read but never change
//      anything, so one leaked from a URL is a smaller problem than a
//      leaked session token.

export const SESSION_COOKIE = "legato_session";
export const MEDIA_TICKET_PARAM = "t";

// Paths the gate owns. Everything else is the web client's static files
// and its SPA fallback (#116), which have to load before anyone can sign in
// at all, so a plain GET/HEAD outside these is let through. Any other
// method, anywhere, still needs a credential. /covers/ matches the list
// routes/web-client.ts keeps for the same reason.
const API_PREFIXES = ["/api/", "/covers/"];

// Matched against the route's own pattern (routeOptions.url), never the raw
// URL, so /api/v1/health/../stats can't sneak through on a prefix check.
// An unmatched URL has no pattern and so is never public: it gets 401,
// not 404, which also keeps the route list private.
const PUBLIC_ROUTES = new Set([
  "GET /api/v1/health",
  "GET /api/v1/auth/status",
  "POST /api/v1/auth/identity",
  "POST /api/v1/auth/owner",
  "GET /api/v1/auth/setup",
  "POST /api/v1/auth/sign-in",
  "POST /api/v1/auth/sign-out",
  "GET /api/v1/auth/google",
  "GET /api/v1/auth/google/callback",
  "GET /api/v1/auth/github",
  "GET /api/v1/auth/github/callback",
]);

export function isPublicRoute(method: string, routeUrl: string | undefined): boolean {
  if (!routeUrl) return false;
  const normalized = method === "HEAD" ? "GET" : method;
  return PUBLIC_ROUTES.has(`${normalized} ${routeUrl}`);
}

function isApiPath(url: string): boolean {
  const path = url.split("?")[0]!;
  return API_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix));
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: SessionUser | null;
    // Set only when authUser came from a legato.fm access token, for the one
    // route that exchanges that token for a session (issue #117).
    legatoClaims: LegatoClaims | null;
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

// Hostnames only: the cookie itself is scoped by host, not port, so the
// desktop dev page on 127.0.0.1:5173 talking to 127.0.0.1:8899 is the same
// party. A page on another host that got the browser to send the cookie
// anyway (SameSite=Lax already stops cross-site POSTs; this is the second
// check) is refused.
function originMatchesHost(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).hostname === new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    return false;
  }
}

type Resolved = { user: SessionUser; claims?: LegatoClaims } | { rejected: string; status?: 403; reason?: string };

// A legato.fm token that verifies but whose account this server doesn't
// know is 403, not 401: signing in again wouldn't help, and the client
// should say "ask the owner for an invite" (#143) rather than show a
// sign-in form.
function resolveLegatoToken(db: Database, token: string): Resolved {
  const identity = legatoIdentity(db);
  if (!identity.enabled) {
    return { rejected: "legato.fm sign-in is turned off on this server (LEGATO_ID_ORIGIN=off)." };
  }
  // Until the owner links an account this server has no keys and fetches
  // none (legatoIdentity.ts), so say that rather than "unknown key, try
  // again", which would never come true.
  if (!anyLinkedAccount(db)) {
    return {
      rejected:
        "This server isn't linked to a legato.fm account yet, so it can't accept legato.fm sign-in. Its owner can link it, or sign in with the owner's password.",
      status: 403,
      reason: "not_linked",
    };
  }
  const result = identity.verify(token);
  if (!result.ok) return { rejected: VERIFY_FAILURE_MESSAGES[result.reason] };
  if (result.claims.scope !== "access") {
    return {
      rejected: "That legato.fm token can only link an account to this server, not open it.",
      status: 403,
      reason: "wrong_scope",
    };
  }
  const user = userForLegatoClaims(db, result.claims);
  if (!user) {
    return {
      rejected: "This server doesn't know that legato.fm account. Ask the server's owner to invite you.",
      status: 403,
      reason: "not_a_member",
    };
  }
  return { user, claims: result.claims };
}

function resolveCredential(db: Database, request: FastifyRequest): Resolved | null {
  const token = bearerToken(request);
  if (token && looksLikeJws(token)) return resolveLegatoToken(db, token);
  if (token) {
    const user = userForSessionToken(db, token);
    return user ? { user } : { rejected: "That session has expired or was signed out." };
  }

  const cookie = request.cookies[SESSION_COOKIE];
  if (cookie) {
    if (!isSafeMethod(request.method) && !originMatchesHost(request)) {
      return { rejected: "Cross-site request refused." };
    }
    const user = userForSessionToken(db, cookie);
    if (user) return { user };
    // A stale cookie next to a valid ticket (an <img> on the web client
    // after a sign-out elsewhere) falls through to the ticket below.
  }

  const ticket = (request.query as Record<string, unknown> | undefined)?.[MEDIA_TICKET_PARAM];
  if (typeof ticket === "string" && ticket) {
    if (!isSafeMethod(request.method)) return { rejected: "A media ticket can only read." };
    const user = userForMediaTicket(db, ticket);
    return user ? { user } : { rejected: "That session has expired or was signed out." };
  }

  return cookie ? { rejected: "That session has expired or was signed out." } : null;
}

export function installAuthGate(app: FastifyInstance, db: Database): void {
  app.decorateRequest("authUser", null);
  app.decorateRequest("legatoClaims", null);

  app.addHook("onRequest", async (request, reply) => {
    // CORS preflight carries no credentials by design, and @fastify/cors
    // answers it itself.
    if (request.method === "OPTIONS") return;
    if (isSafeMethod(request.method) && !isApiPath(request.url)) return;

    // Resolved before the public check, so the public routes that care who
    // is asking (GET /auth/status) can read authUser too.
    const resolved = resolveCredential(db, request);
    if (resolved && "user" in resolved) {
      request.authUser = resolved.user;
      request.legatoClaims = resolved.claims ?? null;
    }

    if (isPublicRoute(request.method, request.routeOptions.url)) return;
    if (request.authUser) return;

    // "owner_required" tells the client to show "create the owner for this
    // server" rather than a sign-in form nobody has a password for — the
    // upgraded-server case, where the library is all still here and only
    // the account is missing.
    if (resolved && "rejected" in resolved && resolved.status === 403) {
      return reply.code(403).send({ error: resolved.rejected, reason: resolved.reason });
    }
    const reason = ownerExists(db) ? "signed_out" : "owner_required";
    const error =
      resolved && "rejected" in resolved
        ? resolved.rejected
        : reason === "owner_required"
          ? "This server needs an owner account before it can be used."
          : "Sign in to this server first.";
    return reply.code(401).send({ error, reason });
  });
}

// Media tickets ride in query strings, and Fastify logs every request URL,
// so the default request serializer would write a working credential into
// the log on every cover thumbnail. Replaces just the value.
export function redactCredentials(url: string): string {
  return url.replace(new RegExp(`([?&]${MEDIA_TICKET_PARAM}=)[^&]*`, "g"), "$1[redacted]");
}
