import type { FastifyInstance } from "fastify";
import { registerSocket } from "../ws.js";

export function wsRoutes() {
  return async function routes(app: FastifyInstance) {
    app.get("/ws", { websocket: true }, (socket) => {
      registerSocket(socket);
    });
  };
}
