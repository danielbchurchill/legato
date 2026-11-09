import Fastify from "fastify";
import { describe, expect, it } from "bun:test";
import { clientAddress, installClientAddress, isTailnetAddress, tailnetDeviceAddress } from "./clientAddress.js";
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

// Issue #412: the device a home/away answer is for. tailscale serve sets
// X-Forwarded-For to the device's tailnet address, and only that is trusted,
// only from loopback, and only for that answer.
describe("tailnetDeviceAddress", () => {
  it("is X-Forwarded-For from a loopback peer, as tailscale serve sends it", () => {
    expect(tailnetDeviceAddress(request("127.0.0.1", { "x-forwarded-for": "100.101.102.103" }))).toBe("100.101.102.103");
    expect(tailnetDeviceAddress(request("::1", { "x-forwarded-for": "fd7a:115c:a1e0::9c33:9504" }))).toBe("fd7a:115c:a1e0::9c33:9504");
    expect(tailnetDeviceAddress(request("::ffff:127.0.0.1", { "x-forwarded-for": "100.64.0.7" }))).toBe("100.64.0.7");
  });

  it("is the socket's peer for a device using the tailnet address directly", () => {
    expect(tailnetDeviceAddress(request("100.101.102.103", {}))).toBe("100.101.102.103");
    expect(tailnetDeviceAddress(request("::ffff:100.101.102.103", {}))).toBe("100.101.102.103");
  });

  it("ignores a forged X-Forwarded-For from a LAN peer", () => {
    expect(tailnetDeviceAddress(request("192.168.1.20", { "x-forwarded-for": "100.101.102.103" }))).toBeNull();
    // A tailnet peer can't name another device either.
    expect(tailnetDeviceAddress(request("100.64.0.9", { "x-forwarded-for": "100.101.102.103" }))).toBe("100.64.0.9");
  });

  it("ignores X-Forwarded-For on a request legato.fm's tunnel replayed", () => {
    expect(
      tailnetDeviceAddress(request("127.0.0.1", { "x-legato-tunnel": "203.0.113.9", "x-forwarded-for": "100.101.102.103" })),
    ).toBeNull();
    expect(tailnetDeviceAddress(request("100.64.0.9", { "x-legato-tunnel": "1" }))).toBeNull();
  });

  it("is null for anything that isn't one tailnet address", () => {
    expect(tailnetDeviceAddress(request("127.0.0.1", {}))).toBeNull();
    expect(tailnetDeviceAddress(request("127.0.0.1", { "x-forwarded-for": "192.168.1.20" }))).toBeNull();
    expect(tailnetDeviceAddress(request("127.0.0.1", { "x-forwarded-for": "203.0.113.9, 100.101.102.103" }))).toBeNull();
    expect(tailnetDeviceAddress(request("127.0.0.1", { "x-forwarded-for": "100.128.0.1" }))).toBeNull();
    expect(tailnetDeviceAddress(request("192.168.1.20", {}))).toBeNull();
  });

  it("never changes what clientAddress, isLocalRequest or maySeeSetupCode see", () => {
    const viaServe = request("127.0.0.1", { "x-forwarded-for": "100.101.102.103", host: "pi.tail1234.ts.net" });
    expect(clientAddress(viaServe)).toBe("127.0.0.1");
    // serve passes the .ts.net Host through, so this was never local.
    expect(isLocalRequest(viaServe)).toBe(false);
    const forgedLocal = request("127.0.0.1", { "x-forwarded-for": "100.101.102.103", host: "127.0.0.1:8899" });
    expect(clientAddress(forgedLocal)).toBe("127.0.0.1");
    expect(isLocalRequest(forgedLocal)).toBe(true);
    // A LAN peer naming loopback or a tailnet address is still the LAN peer.
    for (const forwarded of ["127.0.0.1", "100.101.102.103"]) {
      const lan = { host: "192.168.1.5:8899" };
      expect(maySeeSetupCode(request("203.0.113.9", { ...lan, "x-forwarded-for": forwarded }))).toBe(
        maySeeSetupCode(request("203.0.113.9", lan)),
      );
      expect(maySeeSetupCode(request("203.0.113.9", { ...lan, "x-forwarded-for": forwarded }))).toBe(false);
    }
  });

  it("knows a tailnet address when it sees one", () => {
    expect(isTailnetAddress("100.64.0.0")).toBe(true);
    expect(isTailnetAddress("100.127.255.255")).toBe(true);
    expect(isTailnetAddress("100.63.255.255")).toBe(false);
    expect(isTailnetAddress("fd7a:115c:a1e0:ab12::1")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e1::1")).toBe(false);
    expect(isTailnetAddress("not an address")).toBe(false);
  });
});
