import { EventEmitter } from "node:events";
import type { NetworkInterfaceInfo } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
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
  lanInterfaces,
  onLink,
  serviceRecords,
  startDnsSd,
  startResponder,
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

function entry(address: string, netmask: string, more: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  const family = address.includes(":") ? "IPv6" : "IPv4";
  return { address, netmask, family, internal: false, mac: "", cidr: null, scopeid: 0, ...more } as NetworkInterfaceInfo;
}

// The Pi in issue #326: wlan0 on the LAN, and tailscale0 with an address in
// Tailscale's 100.64.0.0/10, which a LAN client without Tailscale can't reach.
const PI = {
  lo: [entry("127.0.0.1", "255.0.0.0", { internal: true }), entry("::1", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", { internal: true })],
  wlan0: [
    entry("192.168.2.121", "255.255.255.0"),
    entry("2a02:c7c:1234::121", "ffff:ffff:ffff:ffff::"),
    entry("fe80::1", "ffff:ffff:ffff:ffff::", { scopeid: 3 }),
  ],
  tailscale0: [entry("100.88.83.70", "255.255.255.255"), entry("fd7a:115c:a1e0::4401:5346", "ffff:ffff:ffff::")],
};

const lan = (name: string, address: string, netmask: string, ...more: string[]): LanInterface => ({
  name,
  address,
  subnets: [{ address, netmask }],
  addresses: [address, ...more],
});
const WLAN = lan("wlan0", "192.168.2.121", "255.255.255.0", "2a02:c7c:1234::121");
const TAILSCALE = lan("tailscale0", "100.88.83.70", "255.255.255.255", "fd7a:115c:a1e0::4401:5346");

const cgnat = (address: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);

// A stand-in socket for each interface, opened through the responder's
// `openSocket`. It joins a tick later, as a real one does once it's bound,
// or fails for an interface named in `failing`. `deliver` hands a packet to
// every open socket, the way Linux does whichever interface it came in on.
function fakeSockets(failing: string[] = []) {
  type Fake = { address: string; events: EventEmitter; sent: Sent[]; destroyed: boolean };
  const opened: Fake[] = [];
  const openSocket = (iface: LanInterface): MdnsSocket => {
    const fake: Fake = { address: iface.address, events: new EventEmitter(), sent: [], destroyed: false };
    opened.push(fake);
    queueMicrotask(() =>
      failing.includes(iface.name) ? fake.events.emit("error", new Error("addMembership EADDRNOTAVAIL")) : fake.events.emit("joined"),
    );
    return {
      on: (event: string, listener: (...args: never[]) => void) => fake.events.on(event, listener as (...args: unknown[]) => void),
      respond: (packet, cb) => {
        fake.sent.push(packet);
        cb?.(null);
      },
      destroy: (cb) => {
        fake.destroyed = true;
        cb?.();
      },
    };
  };
  const deliver = (event: "query" | "response", packet: Partial<Packet>, source = "192.168.2.48") => {
    for (const fake of opened.filter((f) => !f.destroyed)) {
      fake.events.emit(event, { type: event, ...packet }, { address: source, family: "IPv4", port: 5353, size: 0 });
    }
  };
  // The latest socket opened on an address.
  const on = (address: string) => opened.findLast((f) => f.address === address)!;
  return { openSocket, opened, deliver, on };
}

const tick = () => Bun.sleep(0);
const browse = { questions: [{ name: "_legato._tcp.local", type: "PTR" as const }] };

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
    expect(lanInterfaces(PI)).toEqual([WLAN, TAILSCALE]);
    expect(WLAN.addresses.some(cgnat)).toBe(false);
  });

  it("leave out loopback, link-local addresses, and an interface with no IPv4 address", () => {
    const list = lanInterfaces({
      lo0: [entry("127.0.0.1", "255.0.0.0", { internal: true })],
      en0: [entry("192.168.1.20", "255.255.255.0"), entry("fe80::1", "ffff:ffff:ffff:ffff::", { scopeid: 4 })],
      en1: [entry("fd00::5", "ffff:ffff:ffff:ffff::")],
    });
    expect(list).toEqual([lan("en0", "192.168.1.20", "255.255.255.0")]);
  });

  it("take a question from a client on one of their subnets", () => {
    expect(onLink(WLAN, "192.168.2.48")).toBe(true);
    expect(onLink(WLAN, "192.168.3.48")).toBe(false);
    expect(onLink(TAILSCALE, "192.168.2.48")).toBe(false);
    // Tailscale on Linux and macOS is a /32; on Windows it's the whole /10.
    expect(onLink(TAILSCALE, "100.88.83.71")).toBe(false);
    const windows = lan("Tailscale", "100.88.83.70", "255.192.0.0");
    expect(onLink(windows, "100.101.2.3")).toBe(true);
    expect(onLink(windows, "192.168.2.48")).toBe(false);
    const twoSubnets = { ...WLAN, subnets: [...WLAN.subnets, { address: "10.0.5.1", netmask: "255.255.0.0" }] };
    expect(onLink(twoSubnets, "10.0.200.7")).toBe(true);
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
    expect(addresses(sockets.on("192.168.2.121").sent[0])).toEqual(["192.168.2.121", "2a02:c7c:1234::121"]);
    expect(addresses(sockets.on("100.88.83.70").sent[0])).toEqual(["100.88.83.70", "fd7a:115c:a1e0::4401:5346"]);
    expect(lines).toEqual(['mdns: advertising _legato._tcp as "musicbox" on port 8899 (wlan0, tailscale0)']);
    await advertiser.stop();
  });

  it("answers a LAN client on the LAN interface alone, without the Tailscale address", async () => {
    const sockets = fakeSockets();
    const advertiser = startResponder(AD, { log: () => {}, openSocket: sockets.openSocket, interfaces: () => [WLAN, TAILSCALE] });
    await tick();
    const before = sockets.opened.map((f) => f.sent.length);

    sockets.deliver("query", browse, "192.168.2.48");
    sockets.deliver("query", { questions: [{ name: "legato-0123456789ab.local", type: "A" }] }, "192.168.2.48");
    const wlan = sockets.on("192.168.2.121").sent.slice(before[0]);
    expect(names(wlan[0]!.answers)).toEqual(["PTR _legato._tcp.local"]);
    expect(addresses(wlan[0])).toEqual(["192.168.2.121", "2a02:c7c:1234::121"]);
    expect(addresses(wlan[1])).toEqual(["192.168.2.121"]);
    expect(wlan.flatMap(addresses).some((a) => cgnat(a as string))).toBe(false);
    expect(sockets.on("100.88.83.70").sent).toHaveLength(before[1]!);

    // A question from no interface's subnet gets no answer anywhere.
    sockets.deliver("query", browse, "10.9.8.7");
    expect(sockets.opened.map((f) => f.sent.length)).toEqual([before[0]! + 2, before[1]!]);
    await advertiser.stop();
  });

  it("is found from both subnets of a server on two, at the address on each", async () => {
    const sockets = fakeSockets();
    const eth = lan("eth0", "10.0.0.20", "255.255.255.0");
    const advertiser = startResponder(AD, { log: () => {}, openSocket: sockets.openSocket, interfaces: () => [eth, WLAN] });
    await tick();
    const [eth0, wlan0] = [sockets.on("10.0.0.20"), sockets.on("192.168.2.121")];
    const before = [eth0.sent.length, wlan0.sent.length];
    sockets.deliver("query", browse, "10.0.0.31");
    sockets.deliver("query", browse, "192.168.2.48");
    // One answer each, on the interface the client is on.
    expect([eth0.sent.length, wlan0.sent.length]).toEqual([before[0]! + 1, before[1]! + 1]);
    expect(addresses(eth0.sent.at(-1))).toEqual(["10.0.0.20"]);
    expect(addresses(wlan0.sent.at(-1))).toEqual(["192.168.2.121", "2a02:c7c:1234::121"]);
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
    table = [WLAN, lan("eth0", "10.0.0.20", "255.255.255.0")];
    await Bun.sleep(30);
    expect(addresses(sockets.on("10.0.0.20").sent[0])).toEqual(["10.0.0.20"]);
    expect(lines.at(-1)).toBe("mdns: now advertising on eth0");

    // wlan0 gains an address: the same socket announces it.
    const wlanSocket = sockets.on("192.168.2.121");
    table = [{ ...WLAN, addresses: [...WLAN.addresses, "fd00::121"] }, table[1]!];
    await Bun.sleep(30);
    expect(addresses(wlanSocket.sent.at(-1))).toEqual(["192.168.2.121", "2a02:c7c:1234::121", "fd00::121"]);

    // DHCP moves wlan0: the old socket goes, and one joined on the new
    // address announces it.
    table = [lan("wlan0", "192.168.2.140", "255.255.255.0"), table[1]!];
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

  it("never throws on a socket error, says so once, and sends nothing through that socket", async () => {
    const sockets = fakeSockets(["tailscale0"]);
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
    sockets.deliver("query", browse, "100.88.83.70");
    expect(failed.sent).toHaveLength(0);
    expect(sockets.on("192.168.2.121").sent.length).toBeGreaterThan(0);

    // The next recheck tries again, quietly.
    await Bun.sleep(30);
    expect(failed.destroyed).toBe(true);
    expect(sockets.opened.filter((f) => f.address === "100.88.83.70").length).toBeGreaterThan(1);
    expect(lines.filter((l) => l.includes("not advertising"))).toEqual([
      "mdns: not advertising on tailscale0 (addMembership EADDRNOTAVAIL)",
    ]);
    await advertiser.stop();
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
