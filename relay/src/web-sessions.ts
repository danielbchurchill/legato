import { parseReturnTo } from "./link-codes.js";
import { verifyServerSignature } from "./linked-servers.js";
import { SERVER_ID_PATTERN } from "./signing-keys.js";
import type { Database } from "./sqlite.js";

// A web client signing in to legato.fm (issue #365, migration 0011): the
// request a page brings to /connect (routes/connect-page.ts), and the
// statement in it that its own server signed (server/src/auth/serverKey.ts,
// webClientStatement), vouching that this page, at this origin, is its own.

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// An Ed25519 signature is 64 bytes: 86 base64url characters.
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const EXPIRES_PATTERN = /^\d{1,12}$/;
// A server's name as it signs it: one line, at most 63 characters.
const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,63}$/;

// The longest a statement may say it lasts, past its server's five
// minutes, so a server whose clock runs ahead can't mint one that lasts.
const MAX_STATEMENT_SECONDS = 10 * 60;

// What the fragment the page comes back to carries. Matches
// src/connect/legatoConnect.ts.
export const CONNECT_CODE_PARAM = "legato_connect";
export const CONNECT_CANCELLED = "cancelled";

export type ConnectRequest = {
  serverId: string;
  returnTo: URL;
  codeChallenge: string;
  name: string;
  expiresAt: number;
  signature: string;
};

export type ConnectQuery = {
  server?: unknown;
  return_to?: unknown;
  code_challenge?: unknown;
  name?: unknown;
  expires?: unknown;
  signature?: unknown;
};

// Every part well formed, or nothing: a half-formed request can't be
// finished, so the page says so rather than sending anyone anywhere.
export function parseConnectRequest(query: ConnectQuery | null | undefined): ConnectRequest | null {
  const { server, code_challenge, name, expires, signature } = query ?? {};
  const returnTo = parseReturnTo(query?.return_to);
  if (typeof server !== "string" || !SERVER_ID_PATTERN.test(server)) return null;
  if (typeof code_challenge !== "string" || !CHALLENGE_PATTERN.test(code_challenge)) return null;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) return null;
  if (typeof expires !== "string" || !EXPIRES_PATTERN.test(expires)) return null;
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) return null;
  if (!returnTo) return null;
  return { serverId: server, returnTo, codeChallenge: code_challenge, name, expiresAt: Number(expires), signature };
}

function connectQuery(request: ConnectRequest): URLSearchParams {
  return new URLSearchParams({
    server: request.serverId,
    return_to: request.returnTo.href,
    code_challenge: request.codeChallenge,
    name: request.name,
    expires: String(request.expiresAt),
    signature: request.signature,
  });
}

// The request rebuilt as this service's own /connect path, from its checked
// parts, for a sign-in to come back to (routes/auth.ts).
export function connectPath(request: ConnectRequest): string {
  return `/connect?${connectQuery(request)}`;
}

// What the page sends back to POST /connect, as the page script has it.
export function connectBody(request: ConnectRequest): Record<string, string> {
  return Object.fromEntries(connectQuery(request));
}

// Where a sign-in started from /connect goes back to: only ever /connect
// with a well-formed request, rebuilt from its checked parts.
export function connectReturnPath(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  let url: URL;
  try {
    url = new URL(candidate, "http://relay.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://relay.invalid" || url.pathname !== "/connect") return null;
  const request = parseConnectRequest(Object.fromEntries(url.searchParams));
  return request ? connectPath(request) : null;
}

// The message a server signs: the same lines, in the same order, as
// server/src/auth/serverKey.ts's webClientStatementMessage.
export function webClientStatementMessage(request: ConnectRequest): string {
  return [
    "legato web client",
    request.serverId,
    request.returnTo.origin,
    request.codeChallenge,
    String(request.expiresAt),
    request.name,
  ].join("\n");
}

export type StatementCheck = "ok" | "not_linked" | "expired" | "bad_signature";

// The statement holds when the signed-in account has linked that server,
// and the key the server proved when it was linked signed it, for this
// origin and challenge, and it hasn't run out.
export function checkConnectStatement(db: Database, relayUserId: number, request: ConnectRequest, nowSeconds?: number): StatementCheck {
  const row = db
    .prepare("SELECT public_key FROM linked_servers WHERE relay_user_id = ? AND server_id = ?")
    .get(relayUserId, request.serverId) as { public_key: string } | undefined;
  if (!row) return "not_linked";
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (request.expiresAt <= now || request.expiresAt > now + MAX_STATEMENT_SECONDS) return "expired";
  return verifyServerSignature(row.public_key, webClientStatementMessage(request), request.signature) ? "ok" : "bad_signature";
}

// The page goes back to its own address, with the code where no server
// sees it, or with "cancelled".
export function connectReturnUrl(request: ConnectRequest, code: string): string {
  return `${request.returnTo.href}#${new URLSearchParams({ [CONNECT_CODE_PARAM]: code })}`;
}

export function connectCancelUrl(request: ConnectRequest): string {
  return `${request.returnTo.href}#${new URLSearchParams({ [CONNECT_CODE_PARAM]: CONNECT_CANCELLED })}`;
}
