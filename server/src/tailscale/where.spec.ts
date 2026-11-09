import { describe, expect, it } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { endpointAddress, localNetworks, whereIs, type LocalNetwork, type TailscaleStatus } from "./where.js";

// Issue #412: home, away or unknown, from `tailscale status --json` as the
// Pi's and the Mac's print it (Tailscale 1.102), cut down to the fields
// whereIs reads and a few beside them, with documentation addresses in
// place of real ones. The iPhone's HostName really is "localhost", which is
// why a peer is matched by its addresses.

const PHONE = "100.80.160.20";
const PHONE_V6 = "fd7a:115c:a1e0::cb33:a015";

function status(phone: Record<string, unknown> | null, extraPeers: Record<string, unknown> = {}): TailscaleStatus {
  return {
    Self: {
      HostName: "raspberrypi",
      TailscaleIPs: ["100.88.83.70", "fd7a:115c:a1e0::3f33:5347"],
      // The Pi's own endpoints: its public address, twice (two ports), and
      // its LAN address.
      Addrs: ["198.51.100.7:47324", "198.51.100.7:41641", "192.168.2.23:41641"],
    },
    Peer: {
      "nodekey:mac": {
        HostName: "Daniels-MacBook",
        TailscaleIPs: ["100.101.1.2", "fd7a:115c:a1e0::1"],
        CurAddr: "192.168.2.22:41641",
        Relay: "tor",
      },
      ...(phone
        ? {
            "nodekey:phone": { HostName: "localhost", OS: "iOS", TailscaleIPs: [PHONE, PHONE_V6], Relay: "tor", PeerRelay: "", ...phone },
          }
        : {}),
      ...extraPeers,
    },
  } as unknown as TailscaleStatus;
}

// The Pi's networks: its LAN, and a global IPv6 prefix on the same link.
const PI_NETWORKS: LocalNetwork[] = [
  { address: "192.168.2.23", prefix: 24, family: "ipv4" },
  { address: "2001:db8:aa:1::23", prefix: 64, family: "ipv6" },
  { address: "fe80::1", prefix: 64, family: "ipv6" },
];

describe("whereIs", () => {
  it("is home for a peer reached at an address on one of this machine's networks", () => {
    expect(whereIs(status({ CurAddr: "192.168.2.40:41641", Active: true }), PHONE, PI_NETWORKS)).toBe("home");
  });

  it("is away for a peer reached at a public address", () => {
    expect(whereIs(status({ CurAddr: "203.0.113.50:5432", Active: true }), PHONE, PI_NETWORKS)).toBe("away");
  });

  it("is unknown for an idle peer, which has no direct path to say where it is", () => {
    expect(whereIs(status({ CurAddr: "", Active: false }), PHONE, PI_NETWORKS)).toBe("unknown");
    expect(whereIs(status({ Active: false }), PHONE, PI_NETWORKS)).toBe("unknown");
  });

  it("is unknown for a peer relayed through DERP or a peer relay", () => {
    // Relay is the peer's home DERP region whatever the path; an empty
    // CurAddr with traffic flowing is the relay.
    expect(whereIs(status({ CurAddr: "", Active: true, Relay: "tor" }), PHONE, PI_NETWORKS)).toBe("unknown");
    expect(whereIs(status({ CurAddr: "", Active: true, PeerRelay: "100.88.83.71:7777" }), PHONE, PI_NETWORKS)).toBe("unknown");
  });

  it("is home for a peer behind the same NAT, reached at this machine's own public address", () => {
    expect(whereIs(status({ CurAddr: "198.51.100.7:60123", Active: true }), PHONE, PI_NETWORKS)).toBe("home");
  });

  it("compares IPv6 endpoints by prefix too", () => {
    expect(whereIs(status({ CurAddr: "[2001:db8:aa:1:5c3e:1:2:3]:41641" }), PHONE, PI_NETWORKS)).toBe("home");
    expect(whereIs(status({ CurAddr: "[fe80::8c4:aaff:fe01:2]:41641" }), PHONE, PI_NETWORKS)).toBe("home");
    expect(whereIs(status({ CurAddr: "[2001:db8:bbbb:9::4]:41641" }), PHONE, PI_NETWORKS)).toBe("away");
  });

  it("finds the device by any of its tailnet addresses, IPv6 included", () => {
    expect(whereIs(status({ CurAddr: "203.0.113.50:5432" }), PHONE_V6, PI_NETWORKS)).toBe("away");
  });

  it("is unknown for a device that isn't in the list, or this machine itself", () => {
    expect(whereIs(status(null), PHONE, PI_NETWORKS)).toBe("unknown");
    // Never by host name: "localhost" is the iPhone's.
    expect(whereIs(status({ CurAddr: "203.0.113.50:5432" }), "localhost", PI_NETWORKS)).toBe("unknown");
    expect(whereIs(status({ CurAddr: "203.0.113.50:5432" }), "100.88.83.70", PI_NETWORKS)).toBe("unknown");
  });

  it("is unknown with no status, no device, or a status with no peers", () => {
    expect(whereIs(null, PHONE, PI_NETWORKS)).toBe("unknown");
    expect(whereIs(status({ CurAddr: "203.0.113.50:5432" }), null, PI_NETWORKS)).toBe("unknown");
    expect(whereIs({ Self: { TailscaleIPs: ["100.88.83.70"] }, Peer: null }, PHONE, PI_NETWORKS)).toBe("unknown");
    expect(whereIs({}, PHONE, PI_NETWORKS)).toBe("unknown");
  });

  it("is unknown for a CurAddr that isn't an endpoint", () => {
    expect(whereIs(status({ CurAddr: "derp-11" }), PHONE, PI_NETWORKS)).toBe("unknown");
  });

  it("is away when this machine knows none of its networks", () => {
    expect(whereIs(status({ CurAddr: "192.168.2.40:41641" }), PHONE, [])).toBe("away");
  });
});

describe("endpointAddress", () => {
  it("takes the address out of ip:port and [ip]:port", () => {
    expect(endpointAddress("192.168.2.40:41641")).toBe("192.168.2.40");
    expect(endpointAddress("[2001:db8::4]:41641")).toBe("2001:db8::4");
    expect(endpointAddress("[fe80::1%en0]:41641")).toBe("fe80::1");
    expect(endpointAddress("")).toBeNull();
    expect(endpointAddress(null)).toBeNull();
    expect(endpointAddress("derp-11")).toBeNull();
  });
});

function nic(address: string, cidr: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
  return { address, cidr, family, internal, netmask: "", mac: "00:00:00:00:00:00", scopeid: 0 } as NetworkInterfaceInfo;
}

describe("localNetworks", () => {
  it("keeps the LAN's networks, IPv6 included, and leaves out loopback, Tailscale and container bridges", () => {
    const networks = localNetworks({
      lo: [nic("127.0.0.1", "127.0.0.1/8", "IPv4", true), nic("::1", "::1/128", "IPv6", true)],
      eth0: [nic("192.168.2.23", "192.168.2.23/24", "IPv4"), nic("2001:db8:aa:1::23", "2001:db8:aa:1::23/64", "IPv6")],
      wlan0: [nic("fe80::1%wlan0", "fe80::1/64", "IPv6")],
      tailscale0: [
        nic("100.88.83.70", "100.88.83.70/32", "IPv4"),
        nic("fd7a:115c:a1e0::3f33:5347", "fd7a:115c:a1e0::3f33:5347/128", "IPv6"),
      ],
      // A Mac's Tailscale is a utun, as are other VPNs.
      utun4: [nic("100.64.149.3", "100.64.149.3/32", "IPv4")],
      docker0: [nic("172.17.0.1", "172.17.0.1/16", "IPv4")],
      "br-5f2c": [nic("172.18.0.1", "172.18.0.1/16", "IPv4")],
      // Tailscale's addresses on an interface with some other name.
      Tailnet: [nic("100.64.0.9", "100.64.0.9/32", "IPv4")],
    });
    expect(networks).toEqual([
      { address: "192.168.2.23", prefix: 24, family: "ipv4" },
      { address: "2001:db8:aa:1::23", prefix: 64, family: "ipv6" },
      { address: "fe80::1", prefix: 64, family: "ipv6" },
    ]);
  });
});
