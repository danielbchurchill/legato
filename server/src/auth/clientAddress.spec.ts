import Fastify from "fastify";
import { describe, expect, it } from "bun:test";
import { clientAddress, installClientAddress } from "./clientAddress.js";
import { isLocalRequest, maySeeSetupCode } from "./setupCode.js";
import type { FastifyRequest } from "fastify";

// Issue #310: a request legato.fm's tunnel brought arrives from 127.0.0.1,
// and must never be taken for this machine or the LAN.

function request(remoteAddress: string, headers: Record<string, string>): FastifyRequest {
  return { socket: { remoteAddress }, headers } as unknown as FastifyRequest;
}

describe("clientAddress", () => {
  it("is the socket's peer for a request that didn't come through the tunnel", () => {
    expect(clientAddress(request("192.168.1.20", {}))).toBe("192.168.1.20");
    expect(clientAddress(request("127.0.0.1", {}))).toBe("127.0.0.1");
  });

  it("is the device's address, marked as the tunnel's, for a request the tunnel replayed", () => {
    expect(clientAddress(request("127.0.0.1", { "x-legato-tunnel": "203.0.113.9" }))).toBe("tunnel:203.0.113.9");
    expect(clientAddress(request("::1", { "x-legato-tunnel": "2001:db8::7" }))).toBe("tunnel:2001:db8::7");
    // From a relay that didn't say, or said something that isn't an address.
    expect(clientAddress(request("127.0.0.1", { "x-legato-tunnel": "1" }))).toBe("tunnel");
    expect(clientAddress(request("127.0.0.1", { "x-legato-tunnel": "" }))).toBe("tunnel");
  });

  it("keeps the peer's own address for anyone else who sends the mark", () => {
    // So a guesser on the LAN can't pick a fresh sign-in bucket per request.
    expect(clientAddress(request("192.168.1.20", { "x-legato-tunnel": "203.0.113.9" }))).toBe("tunnel:192.168.1.20");
  });

  it("never counts a tunneled request as this machine or the LAN", () => {
    for (const mark of ["1", "127.0.0.1", "192.168.1.5"]) {
      const tunneled = request("127.0.0.1", { "x-legato-tunnel": mark, host: "127.0.0.1:8899" });
      expect(isLocalRequest(tunneled)).toBe(false);
      expect(maySeeSetupCode(tunneled)).toBe(false);
    }
    expect(isLocalRequest(request("127.0.0.1", { host: "127.0.0.1:8899" }))).toBe(true);
    expect(maySeeSetupCode(request("192.168.1.20", { host: "192.168.1.5:8899", "x-legato-tunnel": "1" }))).toBe(false);
  });

  it("is what request.ip says once installed, for whatever reads it later", async () => {
    const app = Fastify();
    installClientAddress(app);
    app.get("/ip", async (req) => req.ip);
    const tunneled = await app.inject({ url: "/ip", remoteAddress: "127.0.0.1", headers: { "x-legato-tunnel": "203.0.113.9" } });
    expect(tunneled.body).toBe("tunnel:203.0.113.9");
    const direct = await app.inject({ url: "/ip", remoteAddress: "192.168.1.20" });
    expect(direct.body).toBe("192.168.1.20");
    await app.close();
  });
});
