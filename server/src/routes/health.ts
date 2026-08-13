import type { FastifyInstance } from "fastify";

export function healthRoutes() {
  return async function routes(app: FastifyInstance) {
    app.get("/health", async () => ({ status: "ok" }));
  };
}
