import type { WebSocket } from "ws";

// Shared pub/sub for the whole app — scan progress today, enrichment
// progress and live node updates (M4/M5/M7/M8) reuse this same broadcaster
// rather than each milestone standing up its own socket set.
const sockets = new Set<WebSocket>();
// Event streams (GET /events, routes/ws.ts): the same messages, for a
// client that can't open a WebSocket to this server (issue #365).
const streams = new Set<(message: string) => void>();

export function registerSocket(socket: WebSocket): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
}

/** Calls `listener` with every message broadcast from now on. Returns the
 * function that stops it. */
export function subscribe(listener: (message: string) => void): () => void {
  streams.add(listener);
  return () => streams.delete(listener);
}

export function broadcast(event: string, payload: unknown): void {
  const message = JSON.stringify({ event, payload });
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
  for (const listener of streams) listener(message);
}
