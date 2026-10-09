import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import type { RequestFrame, TunnelFrame } from "../../../relay/src/protocol.js";

// This server's end of legato.fm's tunnel (issue #310): one outbound
// WebSocket to the relay's /tunnel, signed in with the tunnel credential
// legato.fm minted when this server reported its link (auth/legatoLink.ts).
// Requests a device sends to legato.fm for this server come down it as
// frames, and this replays each one against the server's own HTTP port on
// loopback and streams the answer back up. The frames are the relay's
// protocol (relay/src/protocol.ts), imported for its types only: a
// compiled server has no relay/ directory beside it.
//
// Replaying over loopback HTTP, rather than calling the routes directly,
// means a request through the tunnel runs exactly like one from the LAN:
// the same gate, the same routes, and the same streaming. Audio goes
// through GET /api/v1/files/:id/stream like any other request, as it's
// written, and nothing here waits on a whole response.
//
// It does mean every such request reaches the server from 127.0.0.1, which
// is what this machine's own pages look like (auth/setupCode.ts,
// isLocalRequest). So each one carries TUNNEL_HEADER, set here whatever
// the device sent, and a request that carries it never counts as local.
//
// Staying connected. A dropped connection, a relay restart or a network
// change all look the same from here: the socket closes, or stops
// answering the heartbeat's pings. Either way it reconnects, after a
// delay that doubles each time up to a cap, with jitter so a relay restart
// doesn't bring every server back in the same second. A credential the
// relay refuses (revoked, expired, unknown) stops it for good, with one
// warning: retrying can't fix that, and only linking again brings a new
// one (tunnel/relayTunnel.ts picks that up).

export const TUNNEL_HEADER = "x-legato-tunnel";

export type TunnelState = "connecting" | "connected" | "waiting" | "refused" | "stopped";

export type Backoff = { baseMs: number; capMs: number };

const DEFAULT_BACKOFF: Backoff = { baseMs: 1_000, capMs: 60_000 };
// A connection that stayed up this long starts the next run of retries
// from the base delay again. One that drops sooner keeps backing off, so a
// relay that accepts and then drops straight away isn't hammered.
const STABLE_MS = 60_000;
// The relay pings every 30 s too (relay/src/routes/tunnel.ts). This side
// pings on its own so it notices a dead connection even if the relay's
// pings never arrive.
const HEARTBEAT_MS = 30_000;
// From starting to connect until the relay answers the credential. Covers
// a connect that hangs as well as an answer that never comes.
const AUTH_TIMEOUT_MS = 15_000;
// When the socket holds more than HIGH_WATER bytes it hasn't sent yet, the
// local response is paused until it's back under LOW_WATER. Without it, a
// slow phone on the far side would have a whole FLAC queued in memory here.
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const DRAIN_POLL_MS = 20;
// The same fixed string as every other request to legato.fm
// (auth/legatoIdentity.ts): nothing per install, no version.
const USER_AGENT = "legato-server";

// Headers that belong to one hop, the same list as relay/src/headers.ts.
const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

/** The wait before reconnect attempt `attempt` (0 first): equal jitter on a capped doubling. */
export function backoffDelay(attempt: number, backoff: Backoff, random: () => number = Math.random): number {
  const ceiling = Math.min(backoff.capMs, backoff.baseMs * 2 ** attempt);
  return ceiling / 2 + random() * (ceiling / 2);
}

export type TunnelClientOptions = {
  /** The relay's tunnel endpoint, ws:// or wss://…/tunnel. */
  url: string;
  credential: string;
  /** This server's own HTTP origin on loopback, e.g. http://127.0.0.1:8899. */
  target: string;
  log?: (level: "info" | "warn", message: string) => void;
  backoff?: Backoff;
  heartbeatMs?: number;
  random?: () => number;
  now?: () => number;
};

export class TunnelClient {
  readonly credential: string;
  private readonly options: TunnelClientOptions;
  private readonly target: URL;
  private readonly log: (level: "info" | "warn", message: string) => void;
  private current: TunnelState = "stopped";
  private socket: WebSocket | null = null;
  private attempt = 0;
  private connectedAt: number | null = null;
  private everConnected = false;
  // Whether this run of failed attempts has been logged yet. One line per
  // outage, not one per retry.
  private failing = false;
  private alive = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly requests = new Map<string, ClientRequest>();
  private readonly listeners = new Set<(state: TunnelState) => void>();

  constructor(options: TunnelClientOptions) {
    this.options = options;
    this.credential = options.credential;
    this.target = new URL(options.target);
    this.log = options.log ?? (() => {});
  }

  get state(): TunnelState {
    return this.current;
  }

  /** Calls `listener` on every state change until the returned function is called. */
  onState(listener: (state: TunnelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.current !== "stopped") return;
    this.connect();
  }

  stop(): void {
    this.setState("stopped");
    this.teardown();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private setState(state: TunnelState): void {
    if (this.current === state) return;
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }

  private connect(): void {
    this.setState("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url, { headers: { "User-Agent": USER_AGENT } });
    } catch (err) {
      this.retry(err instanceof Error ? err.message : String(err));
      return;
    }
    this.socket = socket;
    const authTimer = setTimeout(() => this.lost(socket, "legato.fm didn't answer"), AUTH_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      if (this.socket === socket) socket.send(JSON.stringify({ type: "auth", secret: this.credential }));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.alive = true;
      const frame = parseFrame(event.data);
      if (frame?.type === "auth-ok") {
        clearTimeout(authTimer);
        this.connected(socket);
      } else if (frame?.type === "auth-error") {
        clearTimeout(authTimer);
        this.refused(frame.message);
      } else if (frame?.type === "request" && this.current === "connected") {
        this.forward(socket, frame);
      }
    });
    socket.addEventListener("pong", () => {
      if (this.socket === socket) this.alive = true;
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(authTimer);
      this.lost(socket, event.reason ? `closed by legato.fm: ${event.reason}` : `connection closed (${event.code})`);
    });
    socket.addEventListener("error", () => {
      clearTimeout(authTimer);
      this.lost(socket, "couldn't connect");
    });
  }

  private connected(socket: WebSocket): void {
    this.connectedAt = this.now();
    if (!this.everConnected) {
      this.log("info", `legato.fm: tunnel connected to ${this.options.url}; this server can be reached through legato.fm`);
    } else if (this.failing) {
      this.log("info", "legato.fm: tunnel connected again");
    }
    this.everConnected = true;
    this.failing = false;
    this.alive = true;
    this.beatTimer = setInterval(() => {
      if (!this.alive) {
        this.lost(socket, "the connection stopped answering");
        return;
      }
      this.alive = false;
      socket.ping();
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    this.setState("connected");
  }

  // Closes the current socket and everything riding on it, and forgets it,
  // so its own close event, when it comes, finds nothing to do.
  private teardown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.retryTimer = null;
    this.beatTimer = null;
    for (const request of this.requests.values()) request.destroy();
    this.requests.clear();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.terminate();
    } catch {
      // Already closed.
    }
  }

  private lost(socket: WebSocket, why: string): void {
    if (this.socket !== socket) return;
    const upFor = this.connectedAt === null ? 0 : this.now() - this.connectedAt;
    const wasConnected = this.connectedAt !== null;
    this.connectedAt = null;
    this.teardown();
    if (upFor >= STABLE_MS) this.attempt = 0;
    this.retry(why, wasConnected);
  }

  private retry(why: string, wasConnected = false): void {
    if (this.current === "stopped" || this.current === "refused") return;
    const delay = backoffDelay(this.attempt, this.options.backoff ?? DEFAULT_BACKOFF, this.options.random);
    this.attempt += 1;
    if (!this.failing) {
      this.failing = true;
      const what = wasConnected ? "tunnel dropped" : "couldn't open the tunnel";
      this.log("info", `legato.fm: ${what} (${why}); retrying in ${Math.round(delay / 1000)} s, then less often until it's back`);
    }
    this.setState("waiting");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private refused(message: string): void {
    this.log(
      "warn",
      `legato.fm refused this server's tunnel credential (${message}), so the server can't be reached through legato.fm, and it won't ` +
        "try again. To turn remote access back on, link this server to your legato.fm account again: that brings a new credential.",
    );
    this.setState("refused");
    this.teardown();
  }

  // One request from the relay, replayed against this server. Never
  // throws: whatever goes wrong becomes a response-error frame, which the
  // relay turns into a 502 (or a cut-short body, once the status is sent).
  private forward(socket: WebSocket, frame: RequestFrame): void {
    const { requestId } = frame;
    let settled = false;
    const send = (out: TunnelFrame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(out));
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      this.requests.delete(requestId);
      send({ type: "response-error", requestId, message });
    };

    // A path, never a URL: "//elsewhere/x" must stay a path on this server.
    if (typeof frame.path !== "string" || !frame.path.startsWith("/")) return fail("not a path on this server");

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(frame.headers ?? {})) {
      const key = name.toLowerCase();
      if (!HOP_BY_HOP.has(key) && key !== TUNNEL_HEADER && typeof value === "string") headers[key] = value;
    }
    headers[TUNNEL_HEADER] = "1";
    const body = frame.body ? Buffer.from(frame.body, "base64") : undefined;
    if (body) headers["content-length"] = String(body.length);

    const request = httpRequest({
      host: this.target.hostname,
      port: this.target.port,
      method: frame.method,
      path: frame.path,
      headers,
    });
    this.requests.set(requestId, request);

    request.on("response", (response) => {
      send({ type: "response-start", requestId, status: response.statusCode ?? 502, headers: forwardable(response.headers) });
      response.on("data", (chunk: Buffer) => {
        send({ type: "response-chunk", requestId, data: chunk.toString("base64") });
        if (socket.bufferedAmount > HIGH_WATER) {
          response.pause();
          void drained(socket).then(() => response.resume());
        }
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        this.requests.delete(requestId);
        send({ type: "response-end", requestId });
      });
      response.on("error", (err) => fail(err.message));
      response.on("close", () => fail("the server ended the response early"));
    });
    request.on("error", (err) => fail(err.message));
    request.end(body);
  }
}

function parseFrame(data: unknown): TunnelFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(String(data));
    return typeof parsed === "object" && parsed !== null && "type" in parsed ? (parsed as TunnelFrame) : undefined;
  } catch {
    return undefined;
  }
}

function forwardable(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

// Resolves once the socket has sent enough of what's queued, or has closed.
function drained(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount <= LOW_WATER) resolve();
      else setTimeout(check, DRAIN_POLL_MS);
    };
    check();
  });
}
