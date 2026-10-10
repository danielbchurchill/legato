import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createSession, getUserById, getUserBySessionToken, publicUser, sessionToken, type RelayUserRow } from "../accounts.js";
import {
  LINK_REDEEM_FAILURE_MESSAGES,
  mintLinkCode,
  originMacs,
  parseLinkRedeem,
  redeemLinkCode,
  type LinkRedeemFailure,
} from "../link-codes.js";
import { clientAddress, TokenLimiter } from "../rate-limit.js";
import type { SigningKeys } from "../signing-keys.js";
import type { Database } from "../sqlite.js";
import {
  checkConnectStatement,
  connectBody,
  connectCancelUrl,
  connectPath,
  connectReturnUrl,
  parseConnectRequest,
  type ConnectQuery,
  type ConnectRequest,
} from "../web-sessions.js";
import { account, actionPage, allowAnyOrigin, escapeHtml, pageHeaders, signInButtons, type Providers } from "./link-page.js";

// legato.fm/connect (issue #365): where a home server's web client sends
// its owner to sign in to legato.fm, so the page can reach that server
// through the relay when it's away from home. The same round trip as
// /link (link-page.ts, #325), and the same page: it names the address the
// code goes back to and never goes there by itself.
//
// What's different is what the page gets: a session for one server only,
// the one that served it, which that server vouched for with a statement it
// signed (web-sessions.ts). A page some other server served can't name this
// one, since it can't get this server's signature. With that session the
// page can ask only for relay tickets and access tokens for that server
// (routes/auth.ts), and the relay answers its CORS only for that origin.

export type ConnectView =
  | { kind: "bad_request" }
  | { kind: "unavailable" }
  | { kind: "signed_out"; request: ConnectRequest; providers: Providers }
  | { kind: "not_linked"; request: ConnectRequest; user: RelayUserRow }
  | { kind: "stale"; request: ConnectRequest }
  | { kind: "ready"; request: ConnectRequest; user: RelayUserRow };

function addressBlock(request: ConnectRequest): string {
  return `<p class="address" aria-label="page address">${escapeHtml(request.returnTo.origin)}</p>`;
}

const SIGN_OUT = `<button class="button link" type="button" data-action="sign-out">not you? sign out</button>`;

function content(view: ConnectView): { title: string; body: string } {
  switch (view.kind) {
    case "bad_request":
      return {
        title: "That sign-in isn't complete",
        body: "<p>Something was missing from the address that brought you here, so nothing happened. Start again from your Legato server.</p>",
      };
    case "unavailable":
      return {
        title: "Sign-in isn't available yet",
        body: "<p>legato.fm can't sign in Legato's web app yet. Your server works without it at home.</p>",
      };
    case "signed_out":
      return {
        title: "Sign in to legato.fm",
        body: `${addressBlock(view.request)}
    <p>${escapeHtml(view.request.name)}, at this address, wants you signed in to legato.fm, so it can reach you away from home.</p>
    ${signInButtons(connectPath(view.request), view.providers)}`,
      };
    case "not_linked":
      return {
        title: `${escapeHtml(view.request.name)} isn't linked to this account`,
        body: `<p>${account(view.user)} hasn't linked ${escapeHtml(view.request.name)}. Link it from its Settings, signed in as this account, then try again.</p>
    ${SIGN_OUT}`,
      };
    case "stale":
      return {
        title: "That request ran out",
        body: `<p>${escapeHtml(view.request.name)}'s request to sign in lasts five minutes, and this one has run out or wasn't its own. Start again from the server.</p>`,
      };
    case "ready":
      return {
        title: "Sign in on this page?",
        body: `${addressBlock(view.request)}
    <p>Let the page at this address reach ${escapeHtml(view.request.name)} through legato.fm, as ${account(view.user)}?</p>
    <p class="quiet">It can reach that server only, not your other servers or this account's settings.</p>
    <div class="actions">
      <button class="button primary" type="button" data-action="confirm">continue</button>
      <button class="button secondary" type="button" data-action="cancel">cancel</button>
    </div>
    <p class="quiet" role="status" data-status hidden></p>
    ${SIGN_OUT}`,
      };
  }
}

export function connectPage(view: ConnectView, nonce: string): string {
  const { title, body } = content(view);
  const action =
    view.kind === "ready" ? { post: "/connect", request: connectBody(view.request), cancel: connectCancelUrl(view.request) } : null;
  return actionPage({ view: view.kind, title, body, action }, nonce);
}

const STATEMENT_FAILURES = {
  not_linked: { status: 403, error: "That server isn't linked to this account. Link it from its Settings first." },
  expired: { status: 400, error: "That request ran out. Start again from your Legato server." },
  bad_signature: { status: 400, error: "That request wasn't signed by the server it names. Start again from your Legato server." },
} as const;

const REDEEM_MESSAGES: Record<LinkRedeemFailure, string> = {
  ...LINK_REDEEM_FAILURE_MESSAGES,
  not_found: "legato.fm doesn't recognise this sign-in code. Start again from your Legato server.",
  used: "This sign-in code was already used. Start again from your Legato server.",
  expired: "This sign-in code expired. Codes last five minutes; start again from your Legato server.",
  mismatch: "This sign-in code was issued to a different page. Start again from your Legato server.",
};

export function connectPageRoutes(
  db: Database,
  options: { providers: Providers; signingKeys: SigningKeys | null; issuer: string | undefined; limiter?: TokenLimiter },
) {
  const { signingKeys, issuer } = options;
  const ownOrigin = issuer ? new URL(issuer).origin : null;
  const limiter = options.limiter ?? new TokenLimiter();

  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: ConnectQuery }>("/connect", async (request, reply) => {
      const nonce = randomBytes(16).toString("base64");
      pageHeaders(reply, nonce);
      const connect = parseConnectRequest(request.query);
      if (!connect) {
        reply.code(400);
        return connectPage({ kind: "bad_request" }, nonce);
      }
      if (!signingKeys || !issuer) {
        reply.code(503);
        return connectPage({ kind: "unavailable" }, nonce);
      }
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) return connectPage({ kind: "signed_out", request: connect, providers: options.providers }, nonce);
      const check = checkConnectStatement(db, user.id, connect);
      if (check === "not_linked") return connectPage({ kind: "not_linked", request: connect, user }, nonce);
      if (check !== "ok") return connectPage({ kind: "stale", request: connect }, nonce);
      return connectPage({ kind: "ready", request: connect, user }, nonce);
    });

    // The page's continue button, with the session cookie, from this
    // service's own page only, as POST /link requires.
    app.post<{ Body: ConnectQuery | null }>("/connect", async (request, reply) => {
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401);
        return { error: "Sign in to legato.fm first.", reason: "signed_out" };
      }
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== ownOrigin) {
        reply.code(403);
        return { error: "Sign in from legato.fm's own page.", reason: "cross_origin" };
      }
      if (!signingKeys || !issuer) {
        reply.code(503);
        return { error: "legato.fm can't sign in Legato's web app yet.", reason: "signing_not_configured" };
      }
      const connect = parseConnectRequest(request.body);
      if (!connect) {
        reply.code(400);
        return { error: "That sign-in request isn't complete. Start again from your Legato server.", reason: "bad_request" };
      }
      const check = checkConnectStatement(db, user.id, connect);
      if (check !== "ok") {
        reply.code(STATEMENT_FAILURES[check].status);
        return { error: STATEMENT_FAILURES[check].error, reason: check };
      }
      const minted = mintLinkCode(db, user.id, connect, signingKeys.linkOriginKeys[0]!, "connect");
      if (!minted.ok) {
        reply.code(minted.reason === "used" ? 409 : 429);
        return minted.reason === "used"
          ? { error: "That request was already used. Start again from your Legato server.", reason: "used" }
          : {
              error: "This account has too many sign-ins waiting to finish. Wait five minutes for them to expire, then try again.",
              reason: "too_many",
            };
      }
      request.log.info(`connect: account ${user.id} is signing in a web client of server ${connect.serverId}`);
      return { redirect: connectReturnUrl(connect, minted.code) };
    });

    app.options("/connect/redeem", async (request, reply) => {
      allowAnyOrigin(request, reply);
      return reply.code(204).send();
    });

    // A session for the account and the one server the code was minted for,
    // bound to the origin it was sent to. The same brake as /link/redeem:
    // only what a guess looks like counts.
    app.post<{ Body: { code?: unknown; code_verifier?: unknown } | null }>("/connect/redeem", async (request, reply) => {
      allowAnyOrigin(request, reply);
      const input = parseLinkRedeem(request.body);
      if (!input) {
        reply.code(400);
        return { error: REDEEM_MESSAGES.malformed, reason: "malformed" };
      }
      const address = clientAddress(request.headers, request.ip);
      const retryAfter = limiter.retryAfterSeconds(address);
      if (retryAfter > 0) {
        reply.code(429).header("Retry-After", String(retryAfter));
        return { error: `Too many failed sign-in attempts from this address. Try again in ${retryAfter} seconds.`, reason: "rate_limited" };
      }
      if (!signingKeys || !issuer) {
        reply.code(503);
        return { error: "legato.fm can't sign in Legato's web app yet.", reason: "signing_not_configured" };
      }
      const origin = request.headers.origin;
      const result = redeemLinkCode(db, { ...input, origin }, signingKeys.linkOriginKeys, "connect");
      if (!result.ok) {
        if (result.reason === "not_found" || result.reason === "expired") limiter.recordFailure(address);
        reply.code(400);
        return { error: REDEEM_MESSAGES[result.reason], reason: result.reason };
      }
      limiter.recordSuccess(address);
      const user = getUserById(db, result.relayUserId);
      if (!user || typeof origin !== "string") {
        reply.code(400);
        return { error: REDEEM_MESSAGES.not_found, reason: "not_found" };
      }
      const { token, expiresAt } = createSession(db, user.id, {
        serverId: result.serverId,
        originMac: originMacs([signingKeys.linkOriginKeys[0]!], origin)[0]!,
      });
      return { token, expiresAt: expiresAt.toISOString(), user: publicUser(user), serverId: result.serverId };
    });
  };
}
