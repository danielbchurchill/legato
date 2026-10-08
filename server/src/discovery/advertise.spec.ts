import { EventEmitter } from "node:events";
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
  lanAddresses,
  serviceRecords,
  startDnsSd,
  startResponder,
  type MdnsSocket,
} from "./advertise.js";

// Issue #117: the `_legato._tcp` advertisement. The responder is driven
// through a stand-in socket here; scratch runs on a real one (lo0, and
// dns-sd -B against the macOS path) are in the PR.

const AD = { name: "musicbox", serverId: "0123456789abcdef0123456789abcdef", version: "0.4.0", port: 8899 };

type Sent = Pick<Packet, "answers" | "additionals">;

function fakeMdns() {
  const events = new EventEmitter();
  const sent: Sent[] = [];
  let destroyed = false;
  const socket: MdnsSocket = {
    on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener as (...args: unknown[]) => void),
    respond: (packet, cb) => {
      sent.push(packet);
      cb?.(null);
    },
    destroy: (cb) => {
      destroyed = true;
      cb?.();
    },
  };
  return { socket, sent, events, destroyed: () => destroyed };
}

function names(answers: Answer[] | undefined) {
  return (answers ?? []).map((a) => `${a.type} ${a.name}`);
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

  it("leave out loopback and link-local addresses", () => {
    const list = lanAddresses({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "", mac: "", cidr: null }],
      en0: [
        { address: "192.168.1.20", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null },
        { address: "fe80::1", family: "IPv6", internal: false, netmask: "", mac: "", cidr: null, scopeid: 4 },
      ],
    });
    expect(list).toEqual(["192.168.1.20"]);
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
  it("announces at once, answers queries, and says goodbye with TTL 0 when stopped", async () => {
    const mdns = fakeMdns();
    const lines: string[] = [];
    const advertiser = startResponder(AD, { log: (_l, m) => void lines.push(m), mdns: mdns.socket, addresses: () => ["192.168.1.20"] });
    expect(advertiser.backend).toBe("responder");
    expect(names(mdns.sent[0]!.answers)).toContain("PTR _legato._tcp.local");

    mdns.events.emit("query", { type: "query", questions: [{ name: "_legato._tcp.local", type: "PTR" }] });
    expect(names(mdns.sent.at(-1)!.answers)).toEqual(["PTR _legato._tcp.local"]);

    await advertiser.stop();
    const goodbye = mdns.sent.at(-1)!.answers!;
    expect(goodbye.every((r) => rec(r).ttl === 0)).toBe(true);
    expect(mdns.destroyed()).toBe(true);
    expect(lines).toEqual(['mdns: advertising _legato._tcp as "musicbox" on port 8899']);
  });

  it("moves to \"name (2)\" when another server answers for the same instance name", () => {
    const mdns = fakeMdns();
    const lines: string[] = [];
    const advertiser = startResponder(AD, { log: (_l, m) => void lines.push(m), mdns: mdns.socket, addresses: () => [] });
    mdns.events.emit("response", {
      type: "response",
      answers: [{ name: "musicbox._legato._tcp.local", type: "SRV", data: { port: 8899, target: "other.local" } }],
    });
    expect(lines.at(-1)).toBe('mdns: another server is advertising as "musicbox", so this one is "musicbox (2)"');
    mdns.events.emit("query", { type: "query", questions: [{ name: "_legato._tcp.local", type: "PTR" }] });
    expect(rec(mdns.sent.at(-1)!.answers![0]).data).toBe("musicbox (2)._legato._tcp.local");
    // Its own announcement coming back isn't a clash.
    mdns.events.emit("response", { type: "response", answers: mdns.sent.at(-1)!.additionals });
    expect(lines).toHaveLength(2);
    void advertiser.stop();
  });

  it("re-announces when an address changes", async () => {
    const mdns = fakeMdns();
    let addresses = ["192.168.1.20"];
    const advertiser = startResponder(AD, { log: () => {}, mdns: mdns.socket, addresses: () => addresses, recheckMs: 5 });
    addresses = ["192.168.1.31"];
    await Bun.sleep(30);
    const latest = mdns.sent.at(-1)!.answers!.filter((r) => r.type === "A").map((r) => rec(r).data);
    expect(latest).toEqual(["192.168.1.31"]);
    await advertiser.stop();
  });

  it("never throws on a socket error, and says so once", () => {
    const mdns = fakeMdns();
    const lines: string[] = [];
    const advertiser = startResponder(AD, { log: (_l, m) => void lines.push(m), mdns: mdns.socket, addresses: () => [] });
    mdns.events.emit("error", new Error("bind EADDRINUSE 0.0.0.0:5353"));
    mdns.events.emit("error", new Error("bind EADDRINUSE 0.0.0.0:5353"));
    mdns.events.emit("warning", new Error("send EHOSTUNREACH 224.0.0.251:5353"));
    expect(lines.filter((l) => l.includes("not advertising"))).toEqual(["mdns: not advertising on the LAN (bind EADDRINUSE 0.0.0.0:5353)"]);
    void advertiser.stop();
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
