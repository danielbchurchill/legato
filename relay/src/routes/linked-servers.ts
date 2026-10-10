import type { FastifyInstance } from "fastify";
import { getUserBySessionToken, sessionToken } from "../accounts.js";
import {
  acceptLinkProof,
  acceptUnlinkProof,
  listLinkedServers,
  PROOF_FAILURE_MESSAGES,
  removeLinkedServer,
  type ProofFailure,
} from "../linked-servers.js";
import { SERVER_ID_PATTERN, type SigningKeys } from "../signing-keys.js";
import type { Database } from "../sqlite.js";
import type { TunnelRegistry } from "../tunnel-registry.js";

// Recording and removing (account, server) pairs (issue #231). See
// linked-servers.ts for what a pair is and what the proofs prove.
//
// The first two routes are called by a home server, which has no session:
// the signature in the body is what authorizes them, the same way the
// single-use code authorizes /pair/exchange. The other two are the
// account's own, with its session: listing its servers, and taking one off.

const PROOF_FAILURE_STATUS: Record<ProofFailure, number> = {
  malformed: 400,
  bad_token: 401,
  wrong_key: 403,
  bad_signature: 403,
  stale: 401,
  used: 409,
  no_account: 410,
};

export function linkedServerRoutes(
  db: Database,
  options: { signingKeys: SigningKeys | null; issuer: string | undefined; tunnels: TunnelRegistry | undefined },
) {
  const { signingKeys, issuer, tunnels } = options;

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
      const linked = { accountId: String(result.relayUserId), serverId: result.serverId };
      return { linked, tunnel: { credential: result.tunnel.token, expiresAt: result.tunnel.expiresAt.toISOString() } };
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

    // The connect screen's "your servers" (issue #117). The desktop app's
    // webview calls it cross-origin, so it's on routes/auth.ts's CORS list.
    //
    // Each server's tunnel (issue #310): connected, and since when, or not,
    // with when legato.fm last heard from it (null if it never has). A
    // connected server is one this account can reach through the relay
    // (routes/relay.ts lets an account reach exactly the servers it linked).
    app.get("/linked-servers", async (request, reply) => {
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401);
        return { error: "Sign in to legato.fm first.", reason: "signed_out" };
      }
      return {
        servers: listLinkedServers(db, user.id).map(({ serverId, linkedAt, tunnelLastSeenAt, credentialIssuedAt }) => {
          const live = tunnels?.get(serverId);
          return {
            serverId,
            linkedAt: linkedAt.toISOString(),
            tunnel: live
              ? { connected: true, connectedAt: live.connectedAt.toISOString() }
              : { connected: false, lastSeenAt: tunnelLastSeenAt?.toISOString() ?? null },
            credentialIssuedAt: credentialIssuedAt?.toISOString() ?? null,
          };
        }),
      };
    });

    // Revoking from the account's side. The server isn't told: its owner is
    // still linked there, but legato.fm signs only `link` tokens for it until
    // the owner links again. The pair's tunnel credential goes too
    // (linked-servers.ts), so the server's tunnel is refused at the next
    // heartbeat, and stays off until that link brings a new one.
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
