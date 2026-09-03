import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getUserBySessionToken, SESSION_COOKIE } from "../accounts.js";
import { mintPairingCode, redeemPairingCode } from "../pairing.js";

// Bridges an authenticated browser session to a headless home server that
// has no session cookie of its own — see migrations/
// 0002_tunnel_credentials.sql for the two-step design.
//
// /pair/start requires a real relay session because it's minting a code
// *for* a specific signed-in account. /pair/exchange deliberately does
// NOT check for one: the caller redeeming a code is the home server
// itself, which is never going to have a relay session cookie to
// present — the single-use code is what authorizes that call, the same
// way an OAuth device-authorization-grant code does. See routes/relay.ts's
// header comment for the matching design decision on the /relay/* side.
export function pairRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.post("/pair/start", async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401);
        return { error: "sign in first" };
      }

      const { code, expiresAt } = mintPairingCode(db, user.id);
      return { code, expiresAt: expiresAt.toISOString() };
    });

    app.post<{ Body: { code?: string } }>("/pair/exchange", async (request, reply) => {
      const code = request.body?.code;
      if (!code) {
        reply.code(400);
        return { error: "missing code" };
      }

      const result = redeemPairingCode(db, code);
      if (!result.ok) {
        reply.code(result.reason === "not_found" ? 404 : 410);
        return { error: `pairing code ${result.reason === "not_found" ? "not found" : result.reason}` };
      }

      return { credential: result.credential, expiresAt: result.expiresAt.toISOString() };
    });
  };
}
