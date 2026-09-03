import type { WebSocket } from "ws";
import type { RequestFrame, TunnelFrame } from "./protocol.js";

export interface PendingHandlers {
  onStart(status: number, headers: Record<string, string>): void;
  onChunk(data: Buffer): void;
  onEnd(): void;
  onError(message: string): void;
}

interface PendingEntry extends PendingHandlers {
  relayUserId: number;
}

// Owns every authenticated home-server tunnel this relay currently has —
// one per relay_user_id (a map, not a single field, now that auth is
// per-account rather than one global shared secret — see routes/tunnel.ts)
// — and the demultiplexing table that routes response-* frames back to
// the HTTP request that's waiting on them. Many /relay/* HTTP requests,
// from many different accounts, can be in flight at once; each pending
// entry remembers which account's tunnel it belongs to so a disconnect
// only fails that account's own in-flight requests, not everyone else's.
export class TunnelRegistry {
  #tunnels = new Map<number, WebSocket>();
  #pending = new Map<string, PendingEntry>();

  getTunnel(relayUserId: number): WebSocket | undefined {
    return this.#tunnels.get(relayUserId);
  }

  // A second home server authenticating as the same account replaces the
  // first rather than being rejected — the common case is a restart or a
  // flaky network, not a genuinely second device racing for the slot.
  setTunnel(relayUserId: number, socket: WebSocket): void {
    const existing = this.#tunnels.get(relayUserId);
    if (existing && existing !== socket) {
      existing.close(4000, "replaced by a newer tunnel connection");
    }
    this.#tunnels.set(relayUserId, socket);
  }

  // Only clears if `socket` is still this account's active tunnel — an
  // old, already-replaced socket closing later must not clobber a newer
  // one's state.
  clearTunnel(relayUserId: number, socket: WebSocket): void {
    if (this.#tunnels.get(relayUserId) !== socket) return;
    this.#tunnels.delete(relayUserId);
    for (const [requestId, entry] of this.#pending) {
      if (entry.relayUserId !== relayUserId) continue;
      entry.onError("home server tunnel disconnected");
      this.#pending.delete(requestId);
    }
  }

  registerPending(requestId: string, relayUserId: number, handlers: PendingHandlers): void {
    this.#pending.set(requestId, { relayUserId, ...handlers });
  }

  // Lets an HTTP-side abort (mobile client hung up) drop its slot without
  // waiting for a response that will now never be used.
  cancelPending(requestId: string): void {
    this.#pending.delete(requestId);
  }

  sendRequest(socket: WebSocket, frame: RequestFrame): void {
    socket.send(JSON.stringify(frame));
  }

  handleFrame(frame: TunnelFrame): void {
    if (!("requestId" in frame)) return;
    const entry = this.#pending.get(frame.requestId);
    if (!entry) return; // unknown, late, or already-settled requestId

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
