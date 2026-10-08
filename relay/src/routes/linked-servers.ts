import type { FastifyInstance } from "fastify";
import { getUserBySessionToken, sessionToken } from "../accounts.js";
import { acceptLinkProof, acceptUnlinkProof, PROOF_FAILURE_MESSAGES, removeLinkedServer, type ProofFailure } from "../linked-servers.js";
import { SERVER_ID_PATTERN, type SigningKeys } from "../signing-keys.js";
import type { Database } from "../sqlite.js";

// Recording and removing (account, server) pairs (issue #231). See
// linked-servers.ts for what a pair is and what the proofs prove.
//
// The first two routes are called by a home server, which has no session:
// the signature in the body is what authorizes them, the same way the
// single-use code authorizes /pair/exchange. The third is the account's own
// way to take a server off its list, with its session.

const PROOF_FAILURE_STATUS: Record<ProofFailure, number> = {
  malformed: 400,
  bad_token: 401,
  wrong_key: 403,
  bad_signature: 403,
  stale: 401,
  used: 409,
  no_account: 410,
};

export function linkedServerRoutes(db: Database, options: { signingKeys: SigningKeys | null; issuer: string | undefined }) {
  const { signingKeys, issuer } = options;

  return async function routes(app: FastifyInstance) {
    app.post<{ Body: Record<string, unknown> | null }>("/linked-servers", async (request, reply) => {
      if (!signingKeys || !issuer) {
        reply.code(503);
        return { error: "This relay doesn't sign server tokens, so it can't record linked servers.", reason: "signing_not_configured" };
      }
      const result = acceptLinkProof(db, signingKeys, issuer, request.body);
      if (!result.ok) {
        reply.code(PROOF_FAILURE_STATUS[result.reason]);
        return { error: PROOF_FAILURE_MESSAGES[result.reason], reason: result.reason };
      }
      if (result.changed) request.log.info(`linked-servers: account ${result.relayUserId} linked server ${result.serverId}`);
      return { linked: { accountId: String(result.relayUserId), serverId: result.serverId } };
    });

    app.post<{ Body: Record<string, unknown> | null }>("/linked-servers/unlink", async (request, reply) => {
      if (!issuer) {
        reply.code(503);
        return { error: "This relay has no public origin configured (RELAY_AUTH_CALLBACK_BASE_URL).", reason: "not_configured" };
      }
      const result = acceptUnlinkProof(db, issuer, request.body);
      if (!result.ok) {
        reply.code(PROOF_FAILURE_STATUS[result.reason]);
        return { error: PROOF_FAILURE_MESSAGES[result.reason], reason: result.reason };
      }
      if (result.changed) request.log.info(`linked-servers: server ${result.serverId} unlinked account ${result.relayUserId}`);
      return { unlinked: result.changed };
    });

    // Revoking from the account's side. The server isn't told: its owner is
    // still linked there, but legato.fm signs only `link` tokens for it until
    // the owner links again.
    app.delete<{ Params: { serverId: string } }>("/linked-servers/:serverId", async (request, reply) => {
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401);
        return { error: "Sign in to legato.fm first.", reason: "signed_out" };
      }
      if (!SERVER_ID_PATTERN.test(request.params.serverId)) {
        reply.code(400);
        return { error: "That isn't a server id.", reason: "bad_server_id" };
      }
      return { unlinked: removeLinkedServer(db, user.id, request.params.serverId) };
    });
  };
}
