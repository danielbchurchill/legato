import type { FastifyInstance } from "fastify";
import { registerSocket, subscribe } from "../ws.js";

// How often an event stream with nothing to say says so anyway. Anything
// between a client and this server that closes a quiet connection (Fly's
// proxy in front of legato.fm, a NAT) sees a byte well inside its timeout.
export const EVENT_STREAM_HEARTBEAT_MS = 25_000;

export function wsRoutes(options: { heartbeatMs?: number } = {}) {
  const heartbeatMs = options.heartbeatMs ?? EVENT_STREAM_HEARTBEAT_MS;

  return async function routes(app: FastifyInstance) {
    app.get("/ws", { websocket: true }, (socket) => {
      registerSocket(socket);
    });

    // The same events as /ws, as server-sent events (issue #365). A client
    // reaching this server through legato.fm's relay uses this: the tunnel
    // carries HTTP only, and passes a chunked response on as it arrives
    // (server/src/tunnel/client.ts). Each message is one `data:` line of
    // the same JSON /ws sends, which never holds a raw newline.
    app.get("/events", (_request, reply) => {
      reply.hijack();
      // The headers hooks already set (CORS, for a direct cross-origin
      // client) go out with the stream's own.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      reply.raw.write(": connected\n\n");
      const unsubscribe = subscribe((message) => reply.raw.write(`data: ${message}\n\n`));
      const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), heartbeatMs);
      // The response's own close: the request's fires as soon as its (empty)
      // body has been read.
      reply.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    });
  };
}
