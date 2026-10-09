import type { Database } from "../sqlite.js";
import { legatoIdentity } from "./legatoIdentity.js";
import { VERIFY_FAILURE_MESSAGES } from "./legatoToken.js";
import { accountLinkedToOtherUser, linkAccount, linkedAccountId } from "./legatoUsers.js";
import { forgetTunnelCredential, storeTunnelCredential } from "./tunnelCredential.js";

// Linking a user here to a legato.fm account with a `link` token (issues
// #114 and #231). Two callers: POST /auth/legato/link, where the owner
// brings a token from Settings, in the desktop app or the web client
// (issue #325), and creating the owner on /setup with a claim (issue #237,
// auth/claim.ts), where the token came from legato.fm's /pair/exchange.
// Both run the same checks and the same signed report.
//
// The server sees legato.fm's own signature on who the account is, then
// reports the link to legato.fm, signed with this server's identity key
// (auth/serverKey.ts). Nothing changes here unless legato.fm recorded it,
// so the two can't disagree about a link that just failed. The report also
// brings back the tunnel credential, stored with the link: legato.fm mints
// one for a claim's link and, since #325, for a link from Settings too. The
// caller syncs the tunnel once its answer has gone (issue #310, tunnel/
// relayTunnel.ts's syncRelayTunnelOnceAnswered): a link made through the
// tunnel comes down the connection a new credential replaces.

export type LinkOutcome =
  | { ok: true; linked: { accountId: string; email: string | null; name: string | null } }
  | { ok: false; status: number; error: string; reason: string; legatoReason?: string | null };

const ACCOUNT_TAKEN: LinkOutcome = {
  ok: false,
  status: 409,
  error: "That legato.fm account is already linked to another user on this server.",
  reason: "account_taken",
};

export async function linkLegatoAccount(db: Database, userId: number, token: string): Promise<LinkOutcome> {
  const identity = legatoIdentity(db);
  let result = identity.verify(token);
  if (!result.ok && result.reason === "unknown_key") {
    // The one place a request waits on legato.fm: an owner is at the
    // screen, and there are no cached keys yet on a first link.
    if (!(await identity.refresh())) {
      return {
        ok: false,
        status: 502,
        error: `Couldn't reach ${identity.origin} to fetch its signing keys. Check this server's internet connection and try again.`,
        reason: "keys_unavailable",
      };
    }
    result = identity.verify(token);
  }
  if (!result.ok) return { ok: false, status: 401, error: VERIFY_FAILURE_MESSAGES[result.reason], reason: result.reason };
  // An access token is legato.fm saying the link already exists. It
  // can't record one: legato.fm takes only link tokens as proof.
  if (result.claims.scope !== "link") {
    return {
      ok: false,
      status: 403,
      error: 'That legato.fm token opens this server but can\'t link it. Ask legato.fm for one with scope "link".',
      reason: "wrong_scope",
    };
  }
  const accountId = result.claims.sub;
  if (accountLinkedToOtherUser(db, accountId, userId)) return ACCOUNT_TAKEN;

  const reported = await identity.recordLink(token);
  if (!reported.ok) {
    if (reported.reason === "unreachable") {
      return {
        ok: false,
        status: 502,
        error: `Couldn't reach ${identity.origin} to record the link, so nothing changed. Check this server's internet connection and try again.`,
        reason: "legato_unreachable",
      };
    }
    return {
      ok: false,
      status: 409,
      error: `legato.fm didn't record the link, so nothing changed: ${reported.message}`,
      reason: "legato_refused",
      legatoReason: reported.legatoReason,
    };
  }

  const previous = linkedAccountId(db, userId);
  if (!linkAccount(db, userId, accountId).ok) return ACCOUNT_TAKEN;
  if (reported.tunnel && identity.origin) storeTunnelCredential(db, { origin: identity.origin, accountId, ...reported.tunnel });
  // Linking a different account replaces the old one here, so legato.fm
  // stops vouching for the old one too. Best effort, like an unlink. The
  // old account's tunnel credential goes with it, unless this link's
  // already replaced it.
  if (previous && previous !== accountId) {
    forgetTunnelCredential(db, previous);
    await identity.recordUnlink(previous);
  }
  identity.syncSchedule();
  return { ok: true, linked: { accountId, email: result.claims.email, name: result.claims.name } };
}
