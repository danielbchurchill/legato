import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sanitizeHeaders } from "../headers.js";
import type { RequestFrame } from "../protocol.js";
import type { TunnelRegistry } from "../tunnel-registry.js";

// The public side of the relay: a mobile client's HTTP request in, forwarded
// down the one connected home-server tunnel, streamed back out as the
// home server's real response arrives — chunk by chunk, not buffered whole.
// That streaming is the entire reason this exists: the eventual target is
// proxying a multi-megabyte audio stream, not just small JSON payloads.
export function relayRoutes(registry: TunnelRegistry) {
  return async function routes(app: FastifyInstance) {
    app.all("/relay/*", async (request, reply) => {
      const tunnel = registry.getTunnel();
      if (!tunnel) {
        reply.code(503).send({ error: "no home server tunnel connected" });
        return;
      }

      const requestId = randomUUID();
      const targetPath = request.url.slice("/relay".length) || "/";
      const bodyBuffer = request.body instanceof Buffer ? request.body : undefined;

      const frame: RequestFrame = {
        type: "request",
        requestId,
        method: request.method,
        path: targetPath,
        headers: sanitizeHeaders(request.headers),
        ...(bodyBuffer && bodyBuffer.length > 0 ? { body: bodyBuffer.toString("base64") } : {}),
      };

      // Fastify would otherwise manage (and buffer) the reply itself; hijack
      // hands the raw Node ServerResponse to us so writes actually flush
      // onto the socket as response-chunk frames arrive, not after the
      // route handler returns.
      reply.hijack();

      await new Promise<void>((resolve) => {
        registry.registerPending(requestId, {
          onStart: (status, headers) => {
            reply.raw.writeHead(status, headers);
          },
          onChunk: (buf) => {
            reply.raw.write(buf);
          },
          onEnd: () => {
            reply.raw.end();
            resolve();
          },
          onError: (message) => {
            if (!reply.raw.headersSent) {
              reply.raw.writeHead(502, { "content-type": "application/json" });
              reply.raw.end(JSON.stringify({ error: message }));
            } else {
              reply.raw.end();
            }
            resolve();
          },
        });

        request.raw.on("close", () => {
          if (!reply.raw.writableEnded) registry.cancelPending(requestId);
        });

        registry.sendRequest(tunnel, frame);
      });
    });
  };
}
