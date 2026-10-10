import type { Database } from "../sqlite.js";
import type { FastifyInstance } from "fastify";
import { getUserBySessionToken, sessionToken, type RelayUserRow } from "../accounts.js";
import { claimProofSigned, PROOF_FAILURE_MESSAGES, readClaimProof, type ClaimProofFailure } from "../linked-servers.js";
import { claimServerCode, claimStatus, isClaimedFor, redeemPairingCode, type ClaimFailure } from "../pairing.js";
import { clientAddress, type ExchangeLimiter } from "../rate-limit.js";
import { issuedTokenExpiresAt, signServerToken, type SigningKeys } from "../signing-keys.js";

// Links a headless home server, which has no relay session of its own, to
// the legato.fm account someone signed in with. pairing.ts has the design.
//
// /pair/claim needs a real relay session: it adopts a code a home server is
// showing on its /setup page (issue #237), for the server whose QR was
// scanned (issue #324). /pair/exchange deliberately does NOT check for one:
// the caller redeeming a code is the home server itself, which is never
// going to have a relay session cookie to present. The single-use code says
// which account, the same way an OAuth device-authorization-grant code does,
// and a signature from the server's identity key says which server, the
// only one that can redeem the claim. See routes/relay.ts's header comment
// for the matching design decision on the /relay/* side.
//
// Redeeming a code gets the server a `link` token, not a credential. The
// server links its owner with it, as any link does (routes/linked-servers.ts),
// and that report is what mints the credential. pairing.ts has why.

export const CLAIM_FAILURE_MESSAGES: Record<ClaimFailure, string> = {
  bad_code: "That isn't a link from a Legato server's setup page. Scan the QR code on your server's /setup page again.",
  outdated_server:
    "This server is too old to be claimed: its QR code doesn't say which server it is. " +
    "Update Legato on the server, then scan the QR code on its /setup page again.",
  taken:
    "Another legato.fm account has already claimed this code. If you're the one setting up this server, " +
    "don't link that account on its /setup page.",
  used: "This code has already been used to claim a server. Your server shows a new code on its /setup page.",
  too_many: "This account has too many claims waiting. Wait ten minutes for them to expire, then scan the code again.",
};

const CLAIM_FAILURE_STATUS: Record<ClaimFailure, number> = {
  bad_code: 400,
  outdated_server: 400,
  taken: 409,
  used: 410,
  too_many: 429,
};

const CLAIM_PROOF_STATUS: Record<ClaimProofFailure, number> = { malformed: 400, bad_signature: 403, stale: 401 };

export const SIGNING_UNAVAILABLE = "legato.fm can't link servers yet: this relay doesn't sign server tokens.";

export function pairRoutes(
  db: Database,
  options: { signingKeys: SigningKeys | null; issuer: string | undefined; limiter: ExchangeLimiter },
) {
  const { signingKeys, issuer, limiter } = options;
  const ownOrigin = issuer ? new URL(issuer).origin : null;

  return async function routes(app: FastifyInstance) {
    // The claim page (routes/claim-page.ts) posts here with the session
    // cookie. SameSite=Lax keeps other sites' pages from sending it, but
    // legato.fm and its subdomains count as the same site, so a page that
    // says where it's from has to be this service's own. server is the id
    // the QR carried (issue #324): only that server can redeem the claim.
    app.post<{ Body: { code?: unknown; server?: unknown } | null }>("/pair/claim", async (request, reply) => {
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401);
        return { error: "Sign in to legato.fm first.", reason: "signed_out" };
      }
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== ownOrigin) {
        reply.code(403);
        return { error: "Claim a server from legato.fm's own claim page.", reason: "cross_origin" };
      }
      // A claim this service couldn't finish would spend the code for
      // nothing, so say so before taking it.
      if (!signingKeys || !issuer) {
        reply.code(503);
        return { error: SIGNING_UNAVAILABLE, reason: "signing_not_configured" };
      }
      const result = claimServerCode(db, user.id, request.body?.code, request.body?.server);
      if (!result.ok) {
        reply.code(CLAIM_FAILURE_STATUS[result.reason]);
        return { error: CLAIM_FAILURE_MESSAGES[result.reason], reason: result.reason };
      }
      if (!result.already) request.log.info(`pair: account ${user.id} claimed a server's setup code`);
      return { claimed: { code: result.code, expiresAt: result.expiresAt.toISOString() }, already: result.already };
    });

    // What the claim page polls while it waits for the server to pick its
    // claim up. Only ever about the signed-in account's own claim.
    app.get<{ Querystring: { code?: string } }>("/pair/claim", async (request, reply) => {
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401);
        return { error: "Sign in to legato.fm first.", reason: "signed_out" };
      }
      return { status: claimStatus(db, user.id, request.query.code) };
    });

    // Polled by a home server while its /setup page is open (issue #237):
    // 404 until someone claims the code for this server, then a `link`
    // token for the claiming account and this server's id. The same token
    // again if it asks again while the claim lasts, since the first answer
    // may never have reached it; "used" after that (pairing.ts).
    //
    // A code claimed for the server the proof names is that server's claim
    // (issue #324). It's looked up first, by primary key, and checked and
    // answered whatever the limiter says, so nobody else asking from the
    // server's address can hold it up. Anything else is a code this relay
    // has no claim of for that server, claimed for another or for nobody,
    // and the answer is the same 404 whoever signed the proof, so it isn't
    // checked: those asks are what the limiter counts (rate-limit.ts).
    app.post<{ Body: Record<string, unknown> | null }>("/pair/exchange", async (request, reply) => {
      if (!signingKeys || !issuer) {
        reply.code(503);
        return { error: SIGNING_UNAVAILABLE, reason: "signing_not_configured" };
      }
      const read = readClaimProof(request.body);
      if (!read.ok) {
        reply.code(CLAIM_PROOF_STATUS[read.reason]);
        return { error: PROOF_FAILURE_MESSAGES[read.reason], reason: read.reason };
      }
      const { proof } = read;

      if (!isClaimedFor(db, proof.code, proof.serverId)) {
        const retryAfter = limiter.ask(clientAddress(request.headers, request.ip), proof.code);
        if (retryAfter > 0) {
          reply.code(429).header("Retry-After", String(retryAfter));
          return {
            error: `Too many unknown setup codes from this address. Try again in ${retryAfter} seconds.`,
            reason: "rate_limited",
          };
        }
        reply.code(404);
        return { error: "pairing code not found", reason: "not_found" };
      }
      if (!claimProofSigned(issuer, proof)) {
        reply.code(CLAIM_PROOF_STATUS.bad_signature);
        return { error: PROOF_FAILURE_MESSAGES.bad_signature, reason: "bad_signature" };
      }

      const result = redeemPairingCode(db, proof.code, proof.serverId, (relayUserId) => {
        const user = db.prepare("SELECT * FROM relay_users WHERE id = ?").get(relayUserId) as RelayUserRow;
        return signServerToken(signingKeys, { issuer, user, serverId: proof.serverId, scope: "link" }).token;
      });
      if (!result.ok) {
        reply.code(result.reason === "not_found" ? 404 : 410);
        return {
          error: `pairing code ${result.reason === "not_found" ? "not found" : result.reason}`,
          reason: result.reason,
        };
      }

      request.log.info(
        result.again
          ? `pair: server ${proof.serverId} asked again for account ${result.relayUserId}'s claim, and got the same token`
          : `pair: server ${proof.serverId} picked up account ${result.relayUserId}'s claim`,
      );
      return { linkToken: result.linkToken, expiresAt: issuedTokenExpiresAt(result.linkToken).toISOString() };
    });
  };
}
