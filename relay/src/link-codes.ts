import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { s256Challenge, sha256Hex } from "./native-sign-in.js";
import { SERVER_ID_PATTERN } from "./signing-keys.js";
import type { Database } from "./sqlite.js";

// Linking a home server from its web client (issue #325): the one-time code
// legato.fm's /link page sends back to the page that asked, and what it's
// bound to. See migrations/0008_link_codes.sql for the round trip, and
// routes/link-page.ts for the page and its routes.

// Long enough for the page to load, and for its owner to sign in to the
// server again if that session ran out while they were here. The code is
// useless without the verifier, which never leaves that page's tab.
const LINK_CODE_TTL_SQL = "+5 minutes";

// Spent and expired codes are kept five more minutes, so a reuse still
// reads "already used" or "expired" instead of "unknown" in that window.
// That's ten minutes from minting, the retention site/privacy.html states.
// Every mint and redeem sweeps, so a row outlives it only until the next
// of those.
const LINK_CODE_SWEEP_SQL = "-5 minutes";

// How many codes one account may hold unspent and unexpired at once, as
// for claims (pairing.ts's OPEN_CODES_PER_ACCOUNT). An owner needs one; a
// few more covers a page left open and started again.
export const OPEN_LINK_CODES_PER_ACCOUNT = 5;

// mintLinkCode's 32 random bytes in base64url.
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// A base64url SHA-256 digest is always exactly 43 characters.
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636 §4.1: 43 to 128 characters from the unreserved set.
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

// A return address goes into the sign-in's return cookie twice encoded
// (routes/auth.ts): once into the /link path, once as the cookie value. So
// one character of it can take five there: % becomes %25, then %2525. This
// keeps the cookie well under the 4 KB a browser stores, with room for a
// long host name and a path behind a reverse proxy.
const RETURN_TO_MAX_LENGTH = 512;

// What the fragment the page comes back to carries. Matches
// src/connect/legatoLinkReturn.ts.
export const LINK_CODE_PARAM = "legato_link";

// Where a code may be sent: the page that asked, as http(s), with no
// username or password in it. Only its origin and path are kept; the query
// and fragment are dropped, so nothing the address carried comes back.
//
// Any host is accepted. No list could tell a home server on a LAN address,
// a tailnet name or a reverse-proxied https name from anyone else's, so the
// address isn't what keeps a code safe. The verifier is: only the tab that
// asked has it, and the code is spent only from this origin. The page never
// goes there by itself, either: only when a signed-in person presses link or
// cancel on a page that names the host.
export function parseReturnTo(candidate: unknown): URL | null {
  if (typeof candidate !== "string" || candidate.length > RETURN_TO_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const kept = new URL(`${url.origin}${url.pathname}`);
  // Parsing percent-encodes what the address didn't, so it's measured again.
  return kept.href.length <= RETURN_TO_MAX_LENGTH ? kept : null;
}

export type LinkRequest = { serverId: string; returnTo: URL; codeChallenge: string };

export type LinkQuery = { server?: unknown; return_to?: unknown; code_challenge?: unknown };

// All three, well formed, or nothing: a half-formed request can't be
// finished, so the page says so rather than sending anyone anywhere.
export function parseLinkRequest(query: LinkQuery | null | undefined): LinkRequest | null {
  const serverId = query?.server;
  const codeChallenge = query?.code_challenge;
  const returnTo = parseReturnTo(query?.return_to);
  if (typeof serverId !== "string" || !SERVER_ID_PATTERN.test(serverId)) return null;
  if (typeof codeChallenge !== "string" || !CHALLENGE_PATTERN.test(codeChallenge)) return null;
  if (!returnTo) return null;
  return { serverId, returnTo, codeChallenge };
}

// The request rebuilt as this service's own /link path, from its checked
// parts, for a sign-in to come back to (routes/auth.ts).
export function linkPath(request: LinkRequest): string {
  const query = new URLSearchParams({
    server: request.serverId,
    return_to: request.returnTo.href,
    code_challenge: request.codeChallenge,
  });
  return `/link?${query}`;
}

// The return origin as relay.db keeps it. A home server's address is low
// in entropy (a LAN IP and a port, say), so a plain hash of it could be
// reversed by trying them all. An HMAC under a key derived from the signing
// secret (signing-keys.ts), which isn't on the volume, can't be.
function originMac(key: Buffer, origin: string): string {
  return createHmac("sha256", key).update(origin).digest("hex");
}

// Indexed on expires_at (0008), so it never scans the live rows.
function sweepLinkCodes(db: Database): void {
  db.prepare("DELETE FROM relay_link_codes WHERE expires_at <= datetime('now', ?)").run(LINK_CODE_SWEEP_SQL);
}

export type MintLinkCodeResult = { ok: true; code: string } | { ok: false; reason: "too_many" };

// originKey is the signing key's: SigningKeys.linkOriginKeys[0].
export function mintLinkCode(db: Database, relayUserId: number, request: LinkRequest, originKey: Buffer): MintLinkCodeResult {
  return db.transaction((): MintLinkCodeResult => {
    sweepLinkCodes(db);
    const { open } = db
      .prepare(
        `SELECT COUNT(*) AS open FROM relay_link_codes
         WHERE relay_user_id = ? AND used_at IS NULL AND expires_at > datetime('now')`,
      )
      .get(relayUserId) as { open: number };
    if (open >= OPEN_LINK_CODES_PER_ACCOUNT) return { ok: false, reason: "too_many" };

    const code = randomBytes(32).toString("base64url");
    const mac = originMac(originKey, request.returnTo.origin);
    db.prepare(
      `INSERT INTO relay_link_codes (code_hash, relay_user_id, server_id, code_challenge, return_origin_mac, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
    ).run(sha256Hex(code), relayUserId, request.serverId, request.codeChallenge, mac, LINK_CODE_TTL_SQL);
    return { ok: true, code };
  })();
}

// The page goes back to its own address, with the code where no server
// sees it.
export function returnUrl(request: LinkRequest, code: string): string {
  return `${request.returnTo.href}#${new URLSearchParams({ [LINK_CODE_PARAM]: code })}`;
}

// Cancelling goes back with no code, and says so, so the page can tell the
// owner nothing was linked rather than show nothing at all.
export const LINK_CANCELLED = "cancelled";

export function cancelUrl(request: LinkRequest): string {
  return `${request.returnTo.href}#${new URLSearchParams({ [LINK_CODE_PARAM]: LINK_CANCELLED })}`;
}

export type LinkRedeemFailure = "malformed" | "not_found" | "used" | "expired" | "mismatch";

export type LinkRedeemResult = { ok: true; relayUserId: number; serverId: string } | { ok: false; reason: LinkRedeemFailure };

export const LINK_REDEEM_FAILURE_MESSAGES: Record<LinkRedeemFailure, string> = {
  malformed: "code (43 characters) and code_verifier (43 to 128 characters) are both required.",
  not_found: "legato.fm doesn't recognise this link code. Start again from your server's Settings.",
  used: "This link code was already used. Start again from your server's Settings.",
  expired: "This link code expired. Codes last five minutes; start again from your server's Settings.",
  mismatch: "This link code was issued to a different page. Start again from your server's Settings.",
};

export type LinkRedeemInput = { code: string; codeVerifier: string };

// Checked before anything is looked up or counted (routes/link-page.ts): a
// request that couldn't be a code and a verifier is a broken client, not a
// guess.
export function parseLinkRedeem(body: { code?: unknown; code_verifier?: unknown } | null | undefined): LinkRedeemInput | null {
  const code = body?.code;
  const codeVerifier = body?.code_verifier;
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) return null;
  if (typeof codeVerifier !== "string" || !VERIFIER_PATTERN.test(codeVerifier)) return null;
  return { code, codeVerifier };
}

// The code is spent on the first attempt that finds it, before anything
// else is checked (RFC 6749 §4.1.2), the same as redeemAuthCode: a wrong
// guess burns it rather than leaving it open for a second try. origin is
// the redeeming request's Origin header, which a browser always sends on a
// cross-origin POST; it has to be where the code was sent. originKeys are
// SigningKeys.linkOriginKeys, every one of them, so a code minted just
// before a key rotation still redeems after it.
export function redeemLinkCode(
  db: Database,
  input: LinkRedeemInput & { origin?: unknown },
  originKeys: readonly Buffer[],
): LinkRedeemResult {
  const { code, codeVerifier, origin } = input;
  return db.transaction((): LinkRedeemResult => {
    sweepLinkCodes(db);
    const codeHash = sha256Hex(code);
    const row = db
      .prepare(
        `SELECT relay_user_id, server_id, code_challenge, return_origin_mac, used_at,
                expires_at > datetime('now') AS live
         FROM relay_link_codes WHERE code_hash = ?`,
      )
      .get(codeHash) as
      | { relay_user_id: number; server_id: string; code_challenge: string; return_origin_mac: string; used_at: string | null; live: number }
      | undefined;

    if (!row) return { ok: false, reason: "not_found" };
    if (row.used_at) return { ok: false, reason: "used" };
    db.prepare("UPDATE relay_link_codes SET used_at = datetime('now') WHERE code_hash = ?").run(codeHash);
    if (!row.live) return { ok: false, reason: "expired" };

    if (typeof origin !== "string" || !originKeys.some((key) => sameText(originMac(key, origin), row.return_origin_mac))) {
      return { ok: false, reason: "mismatch" };
    }
    if (!sameText(s256Challenge(codeVerifier), row.code_challenge)) return { ok: false, reason: "mismatch" };
    return { ok: true, relayUserId: row.relay_user_id, serverId: row.server_id };
  })();
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
