import { isIP } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { TUNNEL_HEADER } from "../tunnel/client.js";

// Who a request came from, as every address-based decision here sees it:
// the sign-in limiter (routes/auth.ts), isLocalRequest and maySeeSetupCode
// (auth/setupCode.ts), and the request log (index.ts).
//
// Usually that's the socket's peer. Not for a request legato.fm's tunnel
// brought (issue #310): the tunnel client replays it from 127.0.0.1, which
// is what this machine's own pages look like, so the socket says nothing
// about who sent it. Such a request carries TUNNEL_HEADER, and its address
// is "tunnel:<the device's address>", the address legato.fm saw the device
// at, or plain "tunnel" when legato.fm didn't say. That's never loopback
// and never a private address, so tunneled traffic can't get this
// machine's or the LAN's trust by accident, and it never shares a sign-in
// bucket with the desktop app's own loopback sign-ins.
//
// Only the tunnel client, on loopback, gets to name the device. Anyone else
// who sends the mark loses the same privileges, but keeps their own
// address: "tunnel:192.168.1.20", so a guesser on the LAN can't pick a
// fresh sign-in bucket per request by writing a new address into it.

export const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const TUNNEL = "tunnel";

export function clientAddress(request: Pick<FastifyRequest, "headers" | "socket">): string {
  const peer = request.socket?.remoteAddress ?? "";
  const mark = request.headers[TUNNEL_HEADER];
  if (mark === undefined) return peer;
  if (!LOOPBACK_ADDRESSES.has(peer)) return `${TUNNEL}:${peer}`;
  return typeof mark === "string" && isIP(mark) !== 0 ? `${TUNNEL}:${mark}` : TUNNEL;
}

/**
 * Makes `request.ip` this request's clientAddress(), from the first hook
 * on, so a check written later that reaches for request.ip gets the
 * tunnel's address too, never the loopback it was replayed from.
 */
export function installClientAddress(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    Object.defineProperty(request, "ip", { value: clientAddress(request), configurable: true });
  });
}
