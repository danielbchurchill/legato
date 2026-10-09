import type { WebSocket } from "ws";
import type { RequestFrame, TunnelFrame } from "./protocol.js";

export interface PendingHandlers {
  onStart(status: number, headers: Record<string, string>): void;
  onChunk(data: Buffer): void;
  onEnd(): void;
  onError(message: string): void;
}

interface PendingEntry extends PendingHandlers {
  socket: WebSocket;
  // Whether response-start has come: a chunk before it, or a second one,
  // isn't something a Legato server sends.
  started: boolean;
}

export interface Tunnel {
  socket: WebSocket;
  serverId: string;
  // What it authenticated with. The heartbeat (routes/tunnel.ts) checks it
  // again, so a credential that's revoked or runs out while the tunnel is
  // up stops working within one beat rather than at the next reconnect.
  credential: string;
  connectedAt: Date;
  // Cleared when the heartbeat pings, set again by the pong. Still clear
  // at the next beat means the connection is dead.
  alive: boolean;
}

// What handleFrame() made of a frame. "hostile" means the tunnel sent
// something no Legato server sends, and routes/tunnel.ts closes it.
export type FrameVerdict = "ok" | "hostile";

// A header a response may carry to a device: the name an HTTP token, the
// value free of CR, LF and anything else Node's writeHead() refuses.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const MAX_ERROR_MESSAGE = 500;

// Owns every authenticated home-server tunnel this relay currently has,
// one per server id (issue #310), and the demultiplexing table that routes
// response-* frames back to the HTTP request that's waiting on them.
//
// Keyed by server, not by account: one account can link several servers,
// and each keeps its own tunnel. The credential a tunnel authenticates
// with names the server it was minted for (migration 0006), so the key
// comes from legato.fm's own records, never from anything the connection
// says about itself.
//
// Many /relay/* HTTP requests can be in flight at once, through many
// tunnels. Each pending entry remembers the socket its request went down,
// so a socket that closes fails only its own requests, including one
// that a newer connection from the same server has already replaced.
export class TunnelRegistry {
  #tunnels = new Map<string, Tunnel>();
  #pending = new Map<string, PendingEntry>();

  get(serverId: string): Tunnel | undefined {
    return this.#tunnels.get(serverId);
  }

  all(): Tunnel[] {
    return [...this.#tunnels.values()];
  }

  // A second connection for the same server replaces the first rather than
  // being rejected: the common case is a restart or a network change that
  // the old connection hasn't noticed yet, not two servers racing for one
  // slot. The old one is closed, and that fails whatever was still pending
  // on it.
  set(tunnel: Tunnel): void {
    const existing = this.#tunnels.get(tunnel.serverId);
    if (existing && existing.socket !== tunnel.socket) {
      existing.socket.close(4000, "replaced by a newer tunnel connection");
    }
    this.#tunnels.set(tunnel.serverId, tunnel);
  }

  // A socket closed. Fails its pending requests, and forgets the tunnel
  // only if `socket` is still this server's: an old, already-replaced
  // socket closing later must not clobber the newer one.
  drop(serverId: string, socket: WebSocket): void {
    if (this.#tunnels.get(serverId)?.socket === socket) this.#tunnels.delete(serverId);
    for (const [requestId, entry] of this.#pending) {
      if (entry.socket !== socket) continue;
      this.#pending.delete(requestId);
      entry.onError("home server tunnel disconnected");
    }
  }

  registerPending(requestId: string, socket: WebSocket, handlers: PendingHandlers): void {
    this.#pending.set(requestId, { socket, started: false, ...handlers });
  }

  // Lets an HTTP-side abort (mobile client hung up) drop its slot without
  // waiting for a response that will now never be used.
  cancelPending(requestId: string): void {
    this.#pending.delete(requestId);
  }

  sendRequest(socket: WebSocket, frame: RequestFrame): void {
    socket.send(JSON.stringify(frame));
  }

  // `socket` is the tunnel the frame arrived on. A response is only
  // accepted from the tunnel its request went down, so one server can't
  // answer, or cut short, a request meant for another.
  //
  // Nothing in a frame is taken on trust: anyone can claim a server and
  // get a credential, and before this a status of 99999 threw inside the
  // tunnel's message listener and took the relay down. The home server's
  // client builds every frame from what its own HTTP parser accepted
  // (server/src/tunnel/client.ts), so:
  //   * a value HTTP can't carry fails only what it touches: a header is
  //     left off, and a status outside 200–599 (a 1xx is never a final
  //     answer) fails its request with a 502;
  //   * a frame no Legato server sends, a field of the wrong type, a chunk
  //     before the status or a second status, fails its request and comes
  //     back "hostile", and the caller closes the tunnel.
  // Anything that still throws is caught here and counts as hostile.
  handleFrame(socket: WebSocket, frame: TunnelFrame): FrameVerdict {
    if (!("requestId" in frame)) return "ok";
    const entry = this.#pending.get(frame.requestId);
    if (!entry || entry.socket !== socket) return "ok"; // unknown, late, already settled, or not this tunnel's
    try {
      return this.#dispatch(frame.requestId, entry, frame);
    } catch {
      this.#fail(frame.requestId, entry, "the home server sent a response legato.fm couldn't pass on");
      return "hostile";
    }
  }

  #dispatch(requestId: string, entry: PendingEntry, frame: TunnelFrame): FrameVerdict {
    switch (frame.type) {
      case "response-start": {
        if (entry.started || typeof frame.status !== "number" || !isRecord(frame.headers)) return this.#hostile(requestId, entry);
        if (!Number.isInteger(frame.status) || frame.status < 200 || frame.status > 599) {
          this.#fail(requestId, entry, `the home server answered with a status legato.fm can't pass on (${frame.status})`);
          return "ok";
        }
        entry.started = true;
        entry.onStart(frame.status, passableHeaders(frame.headers));
        return "ok";
      }
      case "response-chunk":
        if (!entry.started || typeof frame.data !== "string") return this.#hostile(requestId, entry);
        entry.onChunk(Buffer.from(frame.data, "base64"));
        return "ok";
      case "response-end":
        this.#pending.delete(requestId);
        entry.onEnd();
        return "ok";
      case "response-error":
        this.#pending.delete(requestId);
        entry.onError(
          typeof frame.message === "string" ? frame.message.slice(0, MAX_ERROR_MESSAGE) : "the home server couldn't answer",
        );
        return "ok";
      default:
        return "ok";
    }
  }

  #fail(requestId: string, entry: PendingEntry, message: string): void {
    this.#pending.delete(requestId);
    entry.onError(message);
  }

  #hostile(requestId: string, entry: PendingEntry): FrameVerdict {
    this.#fail(requestId, entry, "the home server sent a response legato.fm couldn't pass on");
    return "hostile";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function passableHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HEADER_NAME.test(name) && typeof value === "string" && HEADER_VALUE.test(value)) result[name] = value;
  }
  return result;
}
