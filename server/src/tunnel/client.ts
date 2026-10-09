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
// relay refuses (revoked, expired, unknown) gets one warning, then one try
// an hour, and another at once whenever the link changes (tunnel/
// relayTunnel.ts). Linking again is what brings a new credential, but a
// refusal can also be legato.fm's own mistake (a restored database, a bad
// deploy), and a server shouldn't need a restart to come back from that.

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
// How long stop() waits for answers already under way before it closes.
const STOP_GRACE_MS = 2_000;
// After a refusal: about an hour, plus up to a quarter more by chance, so
// every server refused by one incident doesn't come back in one burst.
const REFUSED_RETRY_MS = 60 * 60_000;
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
  /** The wait before asking again after a refusal. */
  refusedRetryMs?: number;
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
  // Whether this run of refusals has been warned about. One warning until
  // the credential is accepted again.
  private refusedWarned = false;
  private alive = false;
  private frameWarned = false;
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

  // Answers already under way still go back first, for up to
  // STOP_GRACE_MS: an unlink made through the tunnel is one of them, and
  // its answer must reach the device before the tunnel it came down
  // closes. Nothing new is taken on meanwhile.
  stop(): void {
    this.setState("stopped");
    if (this.requests.size === 0 || this.socket?.readyState !== WebSocket.OPEN) {
      this.teardown();
      return;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.retryTimer = setTimeout(() => this.teardown(), STOP_GRACE_MS);
  }

  /** After a refusal, asks again now rather than at the next hourly try. */
  retryRefused(): void {
    if (this.current !== "refused") return;
    this.teardown();
    this.connect();
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
    // Nothing a frame holds may throw out of this listener: Bun exits on
    // an exception there, and the whole server with it. forward() turns a
    // request it can't replay into an error for that request alone, and
    // anything else that throws is logged, once, and dropped.
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.alive = true;
      try {
        const frame = parseFrame(event.data);
        // auth-ok only means something once, while signing in.
        if (frame?.type === "auth-ok" && this.current === "connecting") {
          clearTimeout(authTimer);
          this.connected(socket);
        } else if (frame?.type === "auth-error") {
          clearTimeout(authTimer);
          this.refused(String(frame.message));
        } else if (frame?.type === "request" && this.current === "connected") {
          this.forward(socket, frame);
        }
      } catch (err) {
        if (this.frameWarned) return;
        this.frameWarned = true;
        this.log("warn", `legato.fm: ignored a tunnel frame this server couldn't handle (${err instanceof Error ? err.message : String(err)})`);
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
    if (this.refusedWarned) {
      this.log("info", "legato.fm: accepted this server's tunnel credential again; this server can be reached through legato.fm");
    } else if (!this.everConnected) {
      this.log("info", `legato.fm: tunnel connected to ${this.options.url}; this server can be reached through legato.fm`);
    } else if (this.failing) {
      this.log("info", "legato.fm: tunnel connected again");
    }
    this.everConnected = true;
    this.failing = false;
    this.refusedWarned = false;
    this.alive = true;
    if (this.beatTimer) clearInterval(this.beatTimer);
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
    const graceful = this.requests.size === 0;
    for (const request of this.requests.values()) request.destroy();
    this.requests.clear();
    const socket = this.socket;
    this.socket = null;
    try {
      // A close frame goes after whatever is still queued, so the last
      // answers aren't cut off. A socket with requests still riding on it,
      // or one that stopped answering, is just dropped.
      if (graceful && socket?.readyState === WebSocket.OPEN) socket.close(1000, "stopped");
      else socket?.terminate();
    } catch {
      // Already closed.
    }
  }

  // A request is over, answered or failed. A client that's stopping
  // closes once the last one is.
  private requestOver(requestId: string): void {
    this.requests.delete(requestId);
    if (this.current === "stopped" && this.requests.size === 0 && this.socket) this.teardown();
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
    if (!this.refusedWarned) {
      this.refusedWarned = true;
      this.log(
        "warn",
        `legato.fm refused this server's tunnel credential (${message}), so this server can't be reached through legato.fm. ` +
          "It will ask again every hour, in case legato.fm refused it by mistake. To turn remote access back on now, link this " +
          "server to your legato.fm account again: a new link brings a new credential.",
      );
    }
    this.setState("refused");
    this.teardown();
    const wait = (this.options.refusedRetryMs ?? REFUSED_RETRY_MS) * (1 + (this.options.random ?? Math.random)() / 4);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  // One request from the relay, replayed against this server. Never
  // throws: whatever goes wrong becomes a response-error frame, which the
  // relay turns into a 502 (or a cut-short body, once the status is sent).
  private forward(socket: WebSocket, frame: RequestFrame): void {
    const { requestId } = frame;
    // Nothing to answer to, or already being answered.
    if (typeof requestId !== "string" || this.requests.has(requestId)) return;
    let settled = false;
    const send = (out: TunnelFrame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(out));
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      send({ type: "response-error", requestId, message });
      this.requestOver(requestId);
    };

    const replay = replayable(frame);
    if (typeof replay === "string") return fail(replay);

    let request: ClientRequest;
    try {
      request = httpRequest({ host: this.target.hostname, port: this.target.port, ...replay.options });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
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
        send({ type: "response-end", requestId });
        this.requestOver(requestId);
      });
      response.on("error", (err) => fail(err.message));
      response.on("close", () => fail("the server ended the response early"));
    });
    request.on("error", (err) => fail(err.message));
    request.end(replay.body);
  }
}

// What node:http would refuse, checked first, because it refuses by
// throwing: a method that isn't an HTTP token, a header name that isn't
// one, a header value with CR, LF or a character past Latin-1, and a path
// with a space or anything past ASCII in it.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const UNSENDABLE_IN_PATH = /[^\x21-\x7e]+/gu;

type Replay = { options: { method: string; path: string; headers: Record<string, string> }; body: Buffer | undefined };

// A request frame as node:http options, or why it can't be replayed. The
// path is sent as a path, never resolved as a URL, so "//elsewhere/x"
// stays a path on this server. A path with raw UTF-8 in it (a search
// for 日本 typed straight into a URL) goes as its percent-encoding, the
// way a browser would send it. A header that can't be sent is left off.
function replayable(frame: RequestFrame): Replay | string {
  const { method, path, body } = frame;
  if (typeof method !== "string" || !TOKEN.test(method)) return "not an HTTP method";
  if (typeof path !== "string" || !path.startsWith("/")) return "not a path on this server";
  const headerList: unknown = frame.headers ?? {};
  if (typeof headerList !== "object" || headerList === null || Array.isArray(headerList)) return "the headers aren't a header list";
  if (body !== undefined && typeof body !== "string") return "the body isn't base64 text";

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(headerList)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === TUNNEL_HEADER || !TOKEN.test(key)) continue;
    if (typeof value === "string" && HEADER_VALUE.test(value)) headers[key] = value;
  }
  headers[TUNNEL_HEADER] = "1";
  const bytes = body ? Buffer.from(body, "base64") : undefined;
  if (bytes) headers["content-length"] = String(bytes.length);

  const encodedPath = path.replace(UNSENDABLE_IN_PATH, (run) =>
    [...Buffer.from(run, "utf8")].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
  return { options: { method, path: encodedPath, headers }, body: bytes };
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
