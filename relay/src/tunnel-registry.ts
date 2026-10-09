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
    this.#pending.set(requestId, { socket, ...handlers });
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
  handleFrame(socket: WebSocket, frame: TunnelFrame): void {
    if (!("requestId" in frame)) return;
    const entry = this.#pending.get(frame.requestId);
    if (!entry || entry.socket !== socket) return; // unknown, late, already settled, or not this tunnel's

    switch (frame.type) {
      case "response-start":
        entry.onStart(frame.status, frame.headers);
        return;
      case "response-chunk":
        entry.onChunk(Buffer.from(frame.data, "base64"));
        return;
      case "response-end":
        this.#pending.delete(frame.requestId);
        entry.onEnd();
        return;
      case "response-error":
        this.#pending.delete(frame.requestId);
        entry.onError(frame.message);
        return;
      default:
        return;
    }
  }
}
