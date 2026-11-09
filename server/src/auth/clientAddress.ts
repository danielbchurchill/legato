import { BlockList, isIP } from "node:net";
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

// Tailscale gives every device an address in 100.64.0.0/10, and an IPv6
// one in fd7a:115c:a1e0::/48.
const TAILNET = new BlockList();
TAILNET.addSubnet("100.64.0.0", 10, "ipv4");
TAILNET.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

function unmapped(address: string): string {
  return address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

/** True for an address on a tailnet. */
export function isTailnetAddress(address: string): boolean {
  const plain = unmapped(address);
  const family = isIP(plain);
  return family !== 0 && TAILNET.check(plain, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The device's own tailnet address, for one thing only: whether that device
 * is at home or away from it (issue #412, tailscale/whereabouts.ts). Null for
 * a request that didn't come from a tailnet address.
 *
 * Behind `tailscale serve`, every request reaches this server from loopback,
 * and serve sets X-Forwarded-For to the device's tailnet address. It sets
 * the header rather than adding to it, so a value the device sent is gone by
 * then (addProxyForwardedHeaders in tailscale's ipn/ipnlocal/serve.go). So
 * the header counts only from a loopback peer, as one address, and never
 * on a request legato.fm's tunnel replayed (which is loopback too). A device
 * that uses the tailnet address directly (100.x:8899) is the socket's peer.
 *
 * Anything on this machine can send that header to 127.0.0.1, so it names
 * a device for the home/away answer and nothing else: a forged one can at
 * worst show or hide a notice about data use. It never reaches
 * clientAddress() above, and so never isLocalRequest, maySeeSetupCode, the
 * sign-in limiter or the request log. That's also why this reads the socket
 * itself, where everything else goes through clientAddress().
 */
export function tailnetDeviceAddress(request: Pick<FastifyRequest, "headers" | "socket">): string | null {
  if (request.headers[TUNNEL_HEADER] !== undefined) return null;
  const peer = request.socket?.remoteAddress ?? "";
  if (LOOPBACK_ADDRESSES.has(peer)) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded !== "string") return null;
    const address = unmapped(forwarded.trim());
    return isTailnetAddress(address) ? address : null;
  }
  const address = unmapped(peer);
  return isTailnetAddress(address) ? address : null;
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
