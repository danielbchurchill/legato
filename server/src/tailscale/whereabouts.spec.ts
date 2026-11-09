import { afterEach, describe, expect, it } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { wsRoutes } from "../routes/ws.js";
import { tailscaleStatusReader } from "./status.js";
import type { LocalNetwork, TailscaleStatus } from "./where.js";
import { WHEREABOUTS_EVENT, Whereabouts } from "./whereabouts.js";

// Issue #412: each device's answer, pushed down its own socket, from one
// shared `tailscale status --json` run every few seconds.

const PHONE = "100.80.160.20";
const LAPTOP = "100.101.1.2";
const NETWORKS: LocalNetwork[] = [{ address: "192.168.2.23", prefix: 24, family: "ipv4" }];

function statusWith(curAddr: Record<string, string>): TailscaleStatus {
  return {
    Self: { TailscaleIPs: ["100.88.83.70"], Addrs: ["198.51.100.7:41641"] },
    Peer: Object.fromEntries(Object.entries(curAddr).map(([ip, addr]) => [`nodekey:${ip}`, { TailscaleIPs: [ip], CurAddr: addr }])),
  };
}

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private onClose: (() => void) | null = null;
  send(message: string) {
    this.sent.push(message);
  }
  on(_event: "close", listener: () => void) {
    this.onClose = listener;
  }
  close() {
    this.readyState = 3;
    this.onClose?.();
  }
  get answers(): string[] {
    return this.sent.map((m) => {
      const { event, payload } = JSON.parse(m);
      expect(event).toBe(WHEREABOUTS_EVENT);
      return payload.where;
    });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const stops: Whereabouts[] = [];
afterEach(() => {
  while (stops.length) stops.pop()!.stop();
});

function watcher(read: () => Promise<TailscaleStatus>, options: { pollMs?: number; log?: (level: string, message: string) => void } = {}) {
  let reads = 0;
  const whereabouts = new Whereabouts({
    readStatus: async () => {
      reads++;
      return read();
    },
    networks: () => NETWORKS,
    pollMs: options.pollMs ?? 20,
    log: options.log,
  });
  stops.push(whereabouts);
  return { whereabouts, reads: () => reads };
}

describe("Whereabouts", () => {
  it("tells a socket from a non-tailnet address 'unknown' once, and never reads the status for it", async () => {
    const { whereabouts, reads } = watcher(async () => statusWith({}));
    const socket = new FakeSocket();
    whereabouts.watch(socket, null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(socket.answers).toEqual(["unknown"]);
    expect(reads()).toBe(0);
  });

  it("answers a tailnet socket as it connects, then only when its answer changes", async () => {
    let status = statusWith({ [PHONE]: "192.168.2.40:41641" });
    const { whereabouts } = watcher(async () => status);
    const socket = new FakeSocket();
    whereabouts.watch(socket, PHONE);
    await settle();
    expect(socket.answers).toEqual(["home"]);

    // The same answer again says nothing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.answers).toEqual(["home"]);

    status = statusWith({ [PHONE]: "" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.answers).toEqual(["home", "unknown"]);

    status = statusWith({ [PHONE]: "203.0.113.50:5432" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.answers).toEqual(["home", "unknown", "away"]);
  });

  it("gives each device its own answer from one shared read", async () => {
    const { whereabouts, reads } = watcher(async () => statusWith({ [PHONE]: "203.0.113.50:5432", [LAPTOP]: "192.168.2.22:41641" }), {
      pollMs: 10_000,
    });
    const phone = new FakeSocket();
    const laptop = new FakeSocket();
    const phoneAgain = new FakeSocket();
    whereabouts.watch(phone, PHONE);
    whereabouts.watch(laptop, LAPTOP);
    await settle();
    // A socket that connects while the last read is recent is answered from it.
    whereabouts.watch(phoneAgain, PHONE);
    expect(phone.answers).toEqual(["away"]);
    expect(laptop.answers).toEqual(["home"]);
    expect(phoneAgain.answers).toEqual(["away"]);
    expect(reads()).toBe(1);
  });

  it("doesn't answer from a read made before the last socket closed: the next socket waits for a new one", async () => {
    let status = statusWith({ [PHONE]: "203.0.113.50:5432" });
    const { whereabouts, reads } = watcher(async () => status, { pollMs: 10_000 });
    const first = new FakeSocket();
    whereabouts.watch(first, PHONE);
    await settle();
    first.close();
    status = statusWith({ [PHONE]: "192.168.2.40:41641" });
    const next = new FakeSocket();
    whereabouts.watch(next, PHONE);
    expect(next.answers).toEqual([]);
    await settle();
    expect(next.answers).toEqual(["home"]);
    expect(reads()).toBe(2);
  });

  it("stops reading once the last tailnet socket closes, and starts again with the next", async () => {
    const { whereabouts, reads } = watcher(async () => statusWith({ [PHONE]: "203.0.113.50:5432" }), { pollMs: 10 });
    const socket = new FakeSocket();
    whereabouts.watch(socket, PHONE);
    await new Promise((resolve) => setTimeout(resolve, 45));
    const whileOpen = reads();
    expect(whileOpen).toBeGreaterThan(1);
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(reads()).toBeLessThanOrEqual(whileOpen + 1);
    const stopped = reads();
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(reads()).toBe(stopped);

    const next = new FakeSocket();
    whereabouts.watch(next, PHONE);
    await settle();
    expect(next.answers).toEqual(["away"]);
  });

  it("says 'unknown' when the status can't be read, and logs it once rather than every read", async () => {
    let fail = true;
    const logs: string[] = [];
    const { whereabouts } = watcher(
      async () => {
        if (fail) throw new Error("failed to connect to local tailscaled");
        return statusWith({ [PHONE]: "203.0.113.50:5432" });
      },
      { pollMs: 10, log: (level, message) => logs.push(`${level}: ${message}`) },
    );
    const socket = new FakeSocket();
    whereabouts.watch(socket, PHONE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.answers).toEqual(["unknown"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("failed to connect to local tailscaled");

    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.answers).toEqual(["unknown", "away"]);
    expect(logs).toEqual([logs[0]!, "info: tailscale: reading tailscaled's status again"]);
  });
});

type ExecCallback = (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void;

describe("tailscaleStatusReader", () => {
  it("runs `status --json` and parses it", async () => {
    const calls: string[] = [];
    const read = tailscaleStatusReader(["tailscale"], (command, args, _options, callback: ExecCallback) => {
      calls.push(`${command} ${args.join(" ")}`);
      callback(null, JSON.stringify(statusWith({ [PHONE]: "" })), "");
    });
    expect(await read()).toEqual(statusWith({ [PHONE]: "" }));
    expect(calls).toEqual(["tailscale status --json"]);
  });

  it("tries the next CLI while one isn't there, and keeps the one that ran", async () => {
    const calls: string[] = [];
    const read = tailscaleStatusReader(
      ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
      (command, _args, _o, callback: ExecCallback) => {
        calls.push(command);
        if (command === "tailscale") return callback(Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }), "", "");
        callback(null, "{}", "");
      },
    );
    await read();
    await read();
    expect(calls).toEqual([
      "tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]);
  });

  it("says why it failed: no CLI, tailscaled out of reach, or output that isn't JSON", async () => {
    const missing = tailscaleStatusReader(["tailscale"], (_c, _a, _o, callback: ExecCallback) =>
      callback(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", ""),
    );
    await expect(missing()).rejects.toThrow("no tailscale CLI found (tried tailscale)");

    const noDaemon = tailscaleStatusReader(["tailscale"], (_c, _a, _o, callback: ExecCallback) =>
      callback(
        Object.assign(new Error("exit 1"), { code: 1 }),
        "",
        "failed to connect to local tailscaled; it doesn't appear to be running\n",
      ),
    );
    await expect(noDaemon()).rejects.toThrow("failed to connect to local tailscaled");

    const garbled = tailscaleStatusReader(["tailscale"], (_c, _a, _o, callback: ExecCallback) => callback(null, "not json", ""));
    await expect(garbled()).rejects.toThrow("isn't JSON");
  });
});

// The route: a socket through `tailscale serve` (loopback, X-Forwarded-For)
// is answered for its device; a forged header from anywhere else isn't.
describe("GET /api/v1/ws, with whereabouts", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  async function serve(): Promise<string> {
    const { whereabouts } = watcher(async () => statusWith({ [PHONE]: "203.0.113.50:5432" }), { pollMs: 10_000 });
    const app = Fastify();
    await app.register(websocket);
    await app.register(wsRoutes({ whereabouts }), { prefix: "/api/v1" });
    apps.push(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    return base.replace(/^http/, "ws");
  }

  async function firstMessage(url: string, headers: Record<string, string>): Promise<unknown> {
    // Bun's WebSocket takes headers, as tailscale serve's upgrade carries them.
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    try {
      return await new Promise((resolve, reject) => {
        socket.onmessage = (message) => resolve(JSON.parse(String(message.data)));
        socket.onerror = () => reject(new Error("socket failed"));
        setTimeout(() => reject(new Error("no message")), 2_000);
      });
    } finally {
      socket.close();
    }
  }

  it("answers the device tailscale serve names", async () => {
    const base = await serve();
    expect(await firstMessage(`${base}/api/v1/ws`, { "x-forwarded-for": PHONE })).toEqual({
      event: WHEREABOUTS_EVENT,
      payload: { where: "away" },
    });
  });

  it("says 'unknown' to a socket that names no tailnet device, or came through legato.fm's tunnel", async () => {
    const base = await serve();
    expect(await firstMessage(`${base}/api/v1/ws`, {})).toEqual({ event: WHEREABOUTS_EVENT, payload: { where: "unknown" } });
    expect(await firstMessage(`${base}/api/v1/ws`, { "x-forwarded-for": PHONE, "x-legato-tunnel": "203.0.113.9" })).toEqual({
      event: WHEREABOUTS_EVENT,
      payload: { where: "unknown" },
    });
  });
});
