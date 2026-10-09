import { EventEmitter } from "node:events";
import type { NetworkInterfaceInfo } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it, jest } from "bun:test";
import type { Answer, Packet } from "dns-packet";

// Every record the responder makes carries ttl and data; dns-packet's union
// type doesn't promise either for OPT records.
type Rec = { type: string; name: string; ttl?: number; data?: unknown };
const rec = (answer: Answer | undefined) => answer as unknown as Rec;
import {
  answerQuestion,
  chooseBackend,
  dnsSdCommand,
  hostLabel,
  instanceLabel,
  joinGroup,
  lanInterfaces,
  serviceRecords,
  startDnsSd,
  startResponder,
  subnetList,
  type LanInterface,
  type MdnsSocket,
} from "./advertise.js";

// Issue #117: the `_legato._tcp` advertisement, and issue #326: answering
// on each interface with that interface's own addresses. The responder is
// driven through stand-in sockets here; scratch runs on real ones (lo0, en0
// beside Tailscale, Linux in Docker, and dns-sd against the macOS path) are
// in the PRs.

const AD = { name: "musicbox", serverId: "0123456789abcdef0123456789abcdef", version: "0.4.0", port: 8899 };

type Sent = Pick<Packet, "answers" | "additionals">;

function entry(cidr: string, more: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  const address = cidr.split("/")[0]!;
  const family = address.includes(":") ? "IPv6" : "IPv4";
  return { address, netmask: "", family, internal: false, mac: "", cidr, scopeid: 0, ...more } as NetworkInterfaceInfo;
}

// The Pi in issue #326: wlan0 on the LAN, and tailscale0 with an address in
// Tailscale's 100.64.0.0/10, which a LAN client without Tailscale can't reach.
const PI = {
  lo: [entry("127.0.0.1/8", { internal: true }), entry("::1/128", { internal: true })],
  wlan0: [entry("192.168.2.121/24"), entry("2a02:c7c:1234::121/64"), entry("fe80::1/64", { scopeid: 3 })],
  tailscale0: [entry("100.88.83.70/32"), entry("fd7a:115c:a1e0::4401:5346/48")],
};

const lan = (name: string, cidr: string, ...more: string[]): LanInterface => {
  const address = cidr.split("/")[0]!;
  return { name, address, subnets: [cidr], addresses: [address, ...more] };
};
const LO: LanInterface = { name: "lo", address: "127.0.0.1", subnets: ["127.0.0.1/8"], addresses: [], loopback: true };
const WLAN = lan("wlan0", "192.168.2.121/24", "2a02:c7c:1234::121");
const TAILSCALE = lan("tailscale0", "100.88.83.70/32", "fd7a:115c:a1e0::4401:5346");
const EVERY = [...WLAN.addresses, ...TAILSCALE.addresses];

const cgnat = (address: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);

// A stand-in socket for each interface, opened through the responder's
// `openSocket`. It joins a tick later, as a real one does once it's bound,
// fails for an interface named in `failing`, and waits to be told for one
// in `waiting`. A send fails while `sendError` is set.
function fakeSockets({ failing = [] as string[], waiting = [] as string[] } = {}) {
  type Fake = {
    name: string;
    address: string;
    events: EventEmitter;
    sent: Sent[];
    destroyed: boolean;
    sendError?: Error;
    join(skipped?: string[]): void;
  };
  const opened: Fake[] = [];
  const openSocket = (iface: LanInterface): MdnsSocket => {
    const events = new EventEmitter();
    const join = (skipped?: string[]) => events.emit("joined", skipped);
    const fake: Fake = { name: iface.name, address: iface.address, events, sent: [], destroyed: false, join };
    opened.push(fake);
    if (!waiting.includes(iface.name)) {
      queueMicrotask(() =>
        failing.includes(iface.name) ? events.emit("error", new Error("joining 224.0.0.251: EADDRNOTAVAIL")) : fake.join(),
      );
    }
    return {
      on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener as (...args: unknown[]) => void),
      respond: (packet, cb) => {
        if (fake.sendError) return cb?.(fake.sendError);
        fake.sent.push(packet);
        cb?.(null);
      },
      destroy: (cb) => {
        fake.destroyed = true;
        cb?.();
      },
    };
  };
  // Hands a packet to every open socket, the way Linux does whichever
  // interface it came in on, or only to `to`, as a unicast one arrives.
  const deliver = (event: "query" | "response", packet: Partial<Packet>, source = "192.168.2.48", to?: Fake[]) => {
    for (const fake of to ?? opened.filter((f) => !f.destroyed)) {
      fake.events.emit(event, { type: event, ...packet }, { address: source, family: "IPv4", port: 5353, size: 0 });
    }
  };
  // The latest socket opened on an address.
  const on = (address: string) => opened.findLast((f) => f.address === address)!;
  const clear = () => opened.forEach((f) => (f.sent.length = 0));
  return { openSocket, opened, deliver, on, clear };
}

const tick = () => Bun.sleep(0);
const browse = { questions: [{ name: "_legato._tcp.local", type: "PTR" as const }] };
const lookup = { questions: [{ name: "legato-0123456789ab.local", type: "A" as const }] };

function names(answers: Answer[] | undefined) {
  return (answers ?? []).map((a) => `${a.type} ${a.name}`);
}

function addresses(packet: Sent | undefined) {
  return [...(packet?.answers ?? []), ...(packet?.additionals ?? [])]
    .filter((r) => r.type === "A" || r.type === "AAAA")
    .map((r) => rec(r).data);
}

describe("records", () => {
  it("advertise the name, id and version in TXT, on a host name of the server's own", () => {
    const records = serviceRecords(AD, "musicbox", ["192.168.1.20", "fd00::20"]);
    expect(records.ptr).toMatchObject({ name: "_legato._tcp.local", type: "PTR", data: "musicbox._legato._tcp.local" });
    expect(records.srv).toMatchObject({ type: "SRV", data: { port: 8899, target: "legato-0123456789ab.local" } });
    expect(rec(records.txt).data).toEqual(["id=0123456789abcdef0123456789abcdef", "version=0.4.0", "name=musicbox"]);
    expect(records.addresses.map((r) => `${r.type} ${rec(r).data}`)).toEqual(["A 192.168.1.20", "AAAA fd00::20"]);
    expect(hostLabel(AD.serverId)).toBe("legato-0123456789ab.local");
  });

  it("keep the instance name to one label", () => {
    expect(instanceLabel("Priya's Mac.lan")).toBe("Priya's Mac-lan");
    expect(instanceLabel("x".repeat(70))).toHaveLength(63);
  });
});

describe("interfaces", () => {
  it("each advertise their own addresses, so the LAN never hears the Tailscale one", () => {
    expect(lanInterfaces(PI)).toEqual([LO, WLAN, TAILSCALE]);
    expect(WLAN.addresses.some(cgnat)).toBe(false);
  });

  it("leave out link-local addresses and an interface with no IPv4 address, and keep an alias label with its interface", () => {
    const list = lanInterfaces({
      lo0: [entry("127.0.0.1/8", { internal: true })],
      en0: [entry("192.168.1.20/24"), entry("fe80::1/64", { scopeid: 4 })],
      en1: [entry("fd00::5/64")],
      eth0: [entry("10.0.0.20/24"), entry("fd00::20/64")],
      "eth0:1": [entry("10.0.5.1/16")],
      // networkInterfaces() gives no cidr for a netmask that isn't one.
      eth1: [entry("172.16.0.9/32", { cidr: null })],
    });
    expect(list).toEqual([
      { ...LO, name: "lo0" },
      lan("en0", "192.168.1.20/24"),
      { name: "eth0", address: "10.0.0.20", subnets: ["10.0.0.20/24", "10.0.5.1/16"], addresses: ["10.0.0.20", "fd00::20", "10.0.5.1"] },
      lan("eth1", "172.16.0.9/32"),
    ]);
  });

  it("take a client's address as on their link when it's on one of their subnets", () => {
    const wlan = subnetList(WLAN.subnets);
    expect(wlan.check("192.168.2.48", "ipv4")).toBe(true);
    expect(wlan.check("192.168.3.48", "ipv4")).toBe(false);
    // Tailscale on Linux and macOS is a /32; on Windows it's the whole /10.
    expect(subnetList(TAILSCALE.subnets).check("100.88.83.71", "ipv4")).toBe(false);
    const windows = subnetList(["100.88.83.70/10"]);
    expect(windows.check("100.101.2.3", "ipv4")).toBe(true);
    expect(windows.check("192.168.2.48", "ipv4")).toBe(false);
    expect(subnetList(["192.168.2.121/24", "10.0.5.1/16"]).check("10.0.200.7", "ipv4")).toBe(true);
  });

  it("join the group, and only a failed join stops one", () => {
    const calls: string[] = [];
    const socket = {
      addMembership: (group: string, address?: string) => void calls.push(`join ${group} on ${address}`),
      setMulticastInterface: () => {
        throw new Error("EADDRNOTAVAIL: address not available, setsockopt");
      },
      setMulticastTTL: (ttl: number) => (calls.push(`ttl ${ttl}`), ttl),
      setMulticastLoopback: (on: boolean) => (calls.push(`loopback ${on}`), on),
    };
    expect(joinGroup(socket, "192.168.2.121")).toEqual(["the multicast interface (EADDRNOTAVAIL: address not available, setsockopt)"]);
    expect(calls).toEqual(["join 224.0.0.251 on 192.168.2.121", "ttl 255", "loopback true"]);
    socket.addMembership = () => {
      throw new Error("EADDRNOTAVAIL: address not available, setsockopt");
    };
    expect(() => joinGroup(socket, "192.168.2.121")).toThrow("joining 224.0.0.251: EADDRNOTAVAIL");
  });
});

describe("answering", () => {
  const records = serviceRecords(AD, "musicbox", ["192.168.1.20"]);

  it("a browse for _legato._tcp gets the instance, with SRV, TXT and the address alongside", () => {
    const reply = answerQuestion(records, { name: "_legato._tcp.local", type: "PTR" })!;
    expect(names(reply.answers)).toEqual(["PTR _legato._tcp.local"]);
    expect(names(reply.additionals)).toEqual([
      "SRV musicbox._legato._tcp.local",
      "TXT musicbox._legato._tcp.local",
      "A legato-0123456789ab.local",
    ]);
  });

  it("a lookup of the instance or its host gets just that", () => {
    expect(names(answerQuestion(records, { name: "musicbox._legato._tcp.local", type: "TXT" })!.answers)).toEqual([
      "TXT musicbox._legato._tcp.local",
    ]);
    expect(names(answerQuestion(records, { name: "legato-0123456789ab.local", type: "A" })!.answers)).toEqual([
      "A legato-0123456789ab.local",
    ]);
    expect(answerQuestion(records, { name: "legato-0123456789ab.local", type: "AAAA" })).toBeNull();
  });

  it("lists the service type for a browse of every type, and ignores everything else", () => {
    expect(answerQuestion(records, { name: "_services._dns-sd._udp.local", type: "PTR" })!.answers![0]).toMatchObject({
      data: "_legato._tcp.local",
    });
    expect(answerQuestion(records, { name: "_airplay._tcp.local", type: "PTR" })).toBeNull();
    expect(answerQuestion(records, { name: "musicbox.local", type: "A" })).toBeNull();
  });
});

describe("startResponder", () => {
  it("announces on every interface once joined, each with its own addresses only", async () => {
    const sockets = fakeSockets();
    const lines: string[] = [];
    const advertiser = startResponder(AD, {
      log: (_l, m) => void lines.push(m),
      openSocket: sockets.openSocket,
      interfaces: () => [WLAN, TAILSCALE],
    });
    expect(advertiser.backend).toBe("responder");
    // Nothing goes out before a socket has joined: it would leave through
    // the default interface.
    expect(sockets.opened.map((f) => f.sent.length)).toEqual([0, 0]);

    await tick();
    expect(names(sockets.on("192.168.2.121").sent[0]!.answers)).toContain("PTR _legato._tcp.local");
    expect(addresses(sockets.on("192.168.2.121").sent[0])).toEqual(WLAN.addresses);
    expect(addresses(sockets.on("100.88.83.70").sent[0])).toEqual(TAILSCALE.addresses);
    expect(lines).toEqual(['mdns: advertising _legato._tcp as "musicbox" on port 8899 (wlan0, tailscale0)']);
    await advertiser.stop();
  });

  it("answers a LAN client once, on the LAN interface alone, without the Tailscale address", async () => {
    const sockets = fakeSockets();
    const advertiser = startResponder(AD, { log: () => {}, openSocket: sockets.openSocket, interfaces: () => [WLAN, TAILSCALE] });
    await tick();
    sockets.clear();

    // Both sockets hear both questions; each is answered once.
    sockets.deliver("query", browse, "192.168.2.48");
    sockets.deliver("query", lookup, "192.168.2.48");
    const wlan = sockets.on("192.168.2.121").sent;
    expect(wlan).toHaveLength(2);
    expect(names(wlan[0]!.answers)).toEqual(["PTR _legato._tcp.local"]);
    expect(addresses(wlan[0])).toEqual(WLAN.addresses);
    expect(addresses(wlan[1])).toEqual(["192.168.2.121"]);
    expect(wlan.flatMap(addresses).some((a) => cgnat(a as string))).toBe(false);
    expect(sockets.on("100.88.83.70").sent).toEqual([]);
    await advertiser.stop();
  });

  it("answers a unicast query on the client's link, whichever socket it reached", async () => {
    const sockets = fakeSockets();
    const advertiser = startResponder(AD, { log: () => {}, openSocket: sockets.openSocket, interfaces: () => [WLAN, TAILSCALE] });
    await tick();
    sockets.clear();

    // RFC 6762 §5.5: a query sent straight to 192.168.2.121:5353 reaches
    // one of the sockets bound there, here tailscale0's.
    sockets.deliver("query", browse, "192.168.2.48", [sockets.on("100.88.83.70")]);
    expect(sockets.on("192.168.2.121").sent).toHaveLength(1);
    expect(addresses(sockets.on("192.168.2.121").sent[0])).toEqual(WLAN.addresses);
    expect(sockets.on("100.88.83.70").sent).toEqual([]);
    await advertiser.stop();
  });

  it("answers a client on none of its subnets once, with every address, on the link the route to it leaves by", async () => {
    const sockets = fakeSockets();
    const routed: string[] = [];
    const advertiser = startResponder(AD, {
      log: () => {},
      openSocket: sockets.openSocket,
      interfaces: () => [WLAN, TAILSCALE],
      route: async (source) => (routed.push(source), "192.168.2.121"),
    });
    await tick();
    sockets.clear();

    // A client whose DHCP failed, heard by both sockets.
    sockets.deliver("query", browse, "169.254.7.7");
    await tick();
    expect(routed).toEqual(["169.254.7.7"]);
    expect(sockets.on("192.168.2.121").sent).toHaveLength(1);
    expect(addresses(sockets.on("192.168.2.121").sent[0])).toEqual(EVERY);
    expect(sockets.on("100.88.83.70").sent).toEqual([]);
    await advertiser.stop();
  });

  it("answers this machine's own queries on loopback, with every address", async () => {
    const sockets = fakeSockets();
    const lines: string[] = [];
    const advertiser = startResponder(AD, {
      log: (_l, m) => void lines.push(m),
      openSocket: sockets.openSocket,
      interfaces: () => [LO, WLAN, TAILSCALE],
    });
    await tick();
    expect(lines).toEqual(['mdns: advertising _legato._tcp as "musicbox" on port 8899 (lo, wlan0, tailscale0)']);
    // A client on this machine can reach every address, and never needs
    // 127.0.0.1 to be told.
    expect(addresses(sockets.on("127.0.0.1").sent[0])).toEqual(EVERY);
    sockets.clear();

    sockets.deliver("query", browse, "127.0.0.1");
    expect(sockets.opened.map((f) => f.sent.length)).toEqual([1, 0, 0]);
    expect(addresses(sockets.on("127.0.0.1").sent[0])).toEqual(EVERY);
    await advertiser.stop();
  });

  it("is found from both subnets of a server on two, at the address on each", async () => {
    const sockets = fakeSockets();
    const eth = lan("eth0", "10.0.0.20/24");
    const advertiser = startResponder(AD, { log: () => {}, openSocket: sockets.openSocket, interfaces: () => [eth, WLAN] });
    await tick();
    sockets.clear();
    sockets.deliver("query", browse, "10.0.0.31");
    sockets.deliver("query", browse, "192.168.2.48");
    // One answer each, on the interface the client is on.
    expect(sockets.opened.map((f) => f.sent.length)).toEqual([1, 1]);
    expect(addresses(sockets.on("10.0.0.20").sent[0])).toEqual(["10.0.0.20"]);
    expect(addresses(sockets.on("192.168.2.121").sent[0])).toEqual(WLAN.addresses);
    await advertiser.stop();
  });

  it("advertises the addresses of interfaces on one subnet together, so none flushes another's", async () => {
    const sockets = fakeSockets();
    const eth = lan("eth0", "192.168.2.10/24");
    let table = [eth, WLAN];
    const advertiser = startResponder(AD, { log: () => {}, openSocket: sockets.openSocket, interfaces: () => table, recheckMs: 5 });
    await tick();
    // Each announcement carries both, its own first.
    expect(addresses(sockets.on("192.168.2.10").sent[0])).toEqual(["192.168.2.10", ...WLAN.addresses]);
    expect(addresses(sockets.on("192.168.2.121").sent[0])).toEqual([...WLAN.addresses, "192.168.2.10"]);
    sockets.clear();

    // The query comes in on both interfaces, and both sockets hear both
    // copies: one answer, with both addresses.
    sockets.deliver("query", browse);
    sockets.deliver("query", browse);
    expect(sockets.opened.map((f) => f.sent.length)).toEqual([1, 0]);
    expect(addresses(sockets.on("192.168.2.10").sent[0])).toEqual(["192.168.2.10", ...WLAN.addresses]);

    // wlan0 goes: eth0 announces itself alone, which flushes wlan0's
    // addresses from the clients' caches.
    table = [eth];
    await Bun.sleep(30);
    expect(addresses(sockets.on("192.168.2.10").sent.at(-1))).toEqual(["192.168.2.10"]);
    await advertiser.stop();
  });

  it("says goodbye with TTL 0 on every interface when stopped", async () => {
    const sockets = fakeSockets();
    const advertiser = startResponder(AD, { log: () => {}, openSocket: sockets.openSocket, interfaces: () => [WLAN, TAILSCALE] });
    await tick();
    await advertiser.stop();
    for (const fake of sockets.opened) {
      expect(fake.sent.at(-1)!.answers!.every((r) => rec(r).ttl === 0)).toBe(true);
      expect(fake.destroyed).toBe(true);
    }
  });

  it("moves to \"name (2)\" when another server answers for the same instance name", async () => {
    const sockets = fakeSockets();
    const lines: string[] = [];
    const advertiser = startResponder(AD, {
      log: (_l, m) => void lines.push(m),
      openSocket: sockets.openSocket,
      interfaces: () => [WLAN, TAILSCALE],
    });
    await tick();
    // Every socket hears it; the server renames once.
    sockets.deliver("response", {
      answers: [{ name: "musicbox._legato._tcp.local", type: "SRV", data: { port: 8899, target: "other.local" } }],
    });
    expect(lines.slice(1)).toEqual(['mdns: another server is advertising as "musicbox", so this one is "musicbox (2)"']);
    for (const fake of sockets.opened) expect(rec(fake.sent.at(-1)!.answers![0]).data).toBe("musicbox (2)._legato._tcp.local");
    sockets.deliver("query", browse);
    expect(rec(sockets.on("192.168.2.121").sent.at(-1)!.answers![0]).data).toBe("musicbox (2)._legato._tcp.local");
    // Its own announcement coming back isn't a clash.
    sockets.deliver("response", { answers: sockets.on("192.168.2.121").sent.at(-1)!.additionals });
    expect(lines).toHaveLength(2);
    await advertiser.stop();
  });

  it("keeps up with interfaces and addresses that come and go", async () => {
    const sockets = fakeSockets();
    const lines: string[] = [];
    let table = [WLAN];
    const advertiser = startResponder(AD, {
      log: (_l, m) => void lines.push(m),
      openSocket: sockets.openSocket,
      interfaces: () => table,
      recheckMs: 5,
    });
    await tick();

    // A cable plugged in: eth0 gets a socket of its own, and announces.
    table = [WLAN, lan("eth0", "10.0.0.20/24")];
    await Bun.sleep(30);
    expect(addresses(sockets.on("10.0.0.20").sent[0])).toEqual(["10.0.0.20"]);
    expect(lines.at(-1)).toBe("mdns: now advertising on eth0");

    // wlan0 gains an address: the same socket announces it.
    const wlanSocket = sockets.on("192.168.2.121");
    table = [{ ...WLAN, addresses: [...WLAN.addresses, "fd00::121"] }, table[1]!];
    await Bun.sleep(30);
    expect(addresses(wlanSocket.sent.at(-1))).toEqual([...WLAN.addresses, "fd00::121"]);

    // DHCP moves wlan0: the old socket goes, and one joined on the new
    // address announces it.
    table = [lan("wlan0", "192.168.2.140/24"), table[1]!];
    await Bun.sleep(30);
    expect(wlanSocket.destroyed).toBe(true);
    expect(addresses(sockets.on("192.168.2.140").sent[0])).toEqual(["192.168.2.140"]);

    // The cable comes out.
    table = [table[0]!];
    await Bun.sleep(30);
    expect(sockets.on("10.0.0.20").destroyed).toBe(true);
    expect(lines.at(-1)).toBe("mdns: no longer advertising on eth0");
    expect(sockets.opened.filter((f) => !f.destroyed).map((f) => f.address)).toEqual(["192.168.2.140"]);
    await advertiser.stop();
  });

  it("says it's advertising on a new interface only once its socket has joined", async () => {
    const sockets = fakeSockets({ waiting: ["eth0"] });
    const lines: string[] = [];
    let table = [WLAN];
    const advertiser = startResponder(AD, {
      log: (_l, m) => void lines.push(m),
      openSocket: sockets.openSocket,
      interfaces: () => table,
      recheckMs: 5,
    });
    await tick();
    table = [WLAN, lan("eth0", "10.0.0.20/24")];
    await Bun.sleep(30);
    expect(sockets.on("10.0.0.20")).toBeDefined();
    expect(lines.filter((l) => l.includes("eth0"))).toEqual([]);
    sockets.on("10.0.0.20").join();
    expect(lines.at(-1)).toBe("mdns: now advertising on eth0");
    await advertiser.stop();
  });

  it("never throws on a socket error, says so once, and sends nothing through that socket", async () => {
    const sockets = fakeSockets({ failing: ["tailscale0"] });
    const lines: string[] = [];
    const advertiser = startResponder(AD, {
      log: (_l, m) => void lines.push(m),
      openSocket: sockets.openSocket,
      interfaces: () => [WLAN, TAILSCALE],
      recheckMs: 5,
    });
    await tick();
    const failed = sockets.on("100.88.83.70");
    failed.events.emit("error", new Error("bind EADDRINUSE 0.0.0.0:5353"));
    failed.events.emit("warning", new Error("send EHOSTUNREACH 224.0.0.251:5353"));
    sockets.clear();
    sockets.deliver("query", browse, "192.168.2.48");
    expect(failed.sent).toEqual([]);
    expect(sockets.on("192.168.2.121").sent).toHaveLength(1);
    expect(addresses(sockets.on("192.168.2.121").sent[0])).toEqual(WLAN.addresses);

    // The next recheck tries again, quietly.
    await Bun.sleep(30);
    expect(failed.destroyed).toBe(true);
    expect(sockets.opened.filter((f) => f.address === "100.88.83.70").length).toBeGreaterThan(1);
    expect(lines.slice(1)).toEqual(["mdns: not advertising on tailscale0 (joining 224.0.0.251: EADDRNOTAVAIL)"]);
    await advertiser.stop();
  });

  it("opens an interface again when sending through it fails, and says when it works again", async () => {
    const failing: string[] = [];
    const sockets = fakeSockets({ failing });
    const lines: string[] = [];
    let table = [WLAN];
    const advertiser = startResponder(AD, {
      log: (_l, m) => void lines.push(m),
      openSocket: sockets.openSocket,
      interfaces: () => table,
      recheckMs: 5,
    });
    await tick();
    const before = sockets.on("192.168.2.121");

    // wlan0 re-created under the same name and address (a USB adapter
    // replugged): the socket's membership points at the one that's gone.
    before.sendError = new Error("send ENODEV 224.0.0.251:5353");
    sockets.deliver("query", browse);
    expect(lines.at(-1)).toBe("mdns: couldn't send on wlan0 (send ENODEV 224.0.0.251:5353); opening it again");
    await Bun.sleep(30);
    expect(before.destroyed).toBe(true);
    expect(names(sockets.on("192.168.2.121").sent[0]!.answers)).toContain("PTR _legato._tcp.local");
    expect(lines.at(-1)).toBe("mdns: now advertising on wlan0");

    // A link opened again starts fresh: DHCP moves it, and a socket that
    // can't join on the new address says so.
    failing.push("wlan0");
    table = [lan("wlan0", "192.168.2.140/24")];
    await Bun.sleep(30);
    expect(lines.at(-1)).toBe("mdns: not advertising on wlan0 (joining 224.0.0.251: EADDRNOTAVAIL)");
    await advertiser.stop();
  });

  it("advertises on an interface whose optional socket settings failed, and says so once", async () => {
    const sockets = fakeSockets({ waiting: ["wlan0"] });
    const lines: string[] = [];
    const advertiser = startResponder(AD, {
      log: (_l, m) => void lines.push(m),
      openSocket: sockets.openSocket,
      interfaces: () => [WLAN],
      recheckMs: 5,
    });
    sockets.on("192.168.2.121").join(["the multicast interface (EADDRNOTAVAIL: address not available, setsockopt)"]);
    expect(lines.at(-1)).toBe(
      "mdns: couldn't set the multicast interface (EADDRNOTAVAIL: address not available, setsockopt) on wlan0; advertising there anyway",
    );
    expect(sockets.on("192.168.2.121").sent).toHaveLength(1);
    await Bun.sleep(30);
    expect(sockets.opened).toHaveLength(1);
    await advertiser.stop();
  });

  it("backs off an interface that keeps failing, to four minutes between tries", async () => {
    jest.useFakeTimers();
    try {
      const sockets = fakeSockets({ failing: ["tailscale0"] });
      const lines: string[] = [];
      const advertiser = startResponder(AD, {
        log: (_l, m) => void lines.push(m),
        openSocket: sockets.openSocket,
        interfaces: () => [WLAN, TAILSCALE],
      });
      const tries = () => sockets.opened.filter((f) => f.name === "tailscale0").length;
      const retriedAt: number[] = [];
      for (let recheck = 1; recheck <= 24; recheck++) {
        await Promise.resolve();
        const before = tries();
        jest.advanceTimersByTime(30_000);
        if (tries() > before) retriedAt.push(recheck);
      }
      // 30 s after the first failure, then 1, 2 and 4 minutes apart.
      expect(retriedAt).toEqual([1, 3, 7, 15, 23]);
      expect(lines.slice(1)).toEqual(["mdns: not advertising on tailscale0 (joining 224.0.0.251: EADDRNOTAVAIL)"]);
      await advertiser.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("macOS: through mDNSResponder", () => {
  it("registers with dns-sd -R, wrapped so it dies with this process", () => {
    const { command, args } = dnsSdCommand(AD);
    expect(command).toBe("/bin/sh");
    expect(args.slice(3)).toEqual(["-R", "musicbox", "_legato._tcp", "local", "8899", ...(rec(serviceRecords(AD, "m", []).txt).data as string[])]);
    expect(args[1]).toContain("read -r _");
  });

  it("logs once registered, re-registers if dns-sd exits, and ends it on stop", async () => {
    const spawned: { stdin: PassThrough; stdout: PassThrough; events: EventEmitter }[] = [];
    const spawnImpl = (() => {
      const events = new EventEmitter();
      const proc = Object.assign(events, { stdin: new PassThrough(), stdout: new PassThrough() });
      spawned.push({ stdin: proc.stdin, stdout: proc.stdout, events });
      return proc;
    }) as unknown as typeof import("node:child_process").spawn;
    const lines: string[] = [];
    const advertiser = startDnsSd(AD, { log: (_l, m) => void lines.push(m), spawnImpl, retryMs: 5 });
    spawned[0]!.stdout.write("12:00:00.001  Got a reply for service musicbox._legato._tcp.local.: Name now registered and active\n");
    await Bun.sleep(0);
    expect(lines).toEqual(['mdns: advertising _legato._tcp as "musicbox" on port 8899, through mDNSResponder']);

    spawned[0]!.events.emit("exit", 1);
    await Bun.sleep(20);
    expect(spawned).toHaveLength(2);

    let ended = false;
    spawned[1]!.stdin.on("finish", () => (ended = true));
    await advertiser.stop();
    await Bun.sleep(0);
    expect(ended).toBe(true);
  });

  it("is the backend on macOS, and the responder everywhere else", () => {
    expect(chooseBackend("darwin", () => true)).toBe("dns-sd");
    expect(chooseBackend("darwin", () => false)).toBe("responder");
    expect(chooseBackend("linux", () => true)).toBe("responder");
    expect(chooseBackend("win32", () => false)).toBe("responder");
  });
});
