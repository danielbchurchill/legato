import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getWorklist } from "../hygiene.js";

export function hygieneRoutes(db: Database.Database) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { type?: string } }>("/hygiene/worklist", async (request) =>
      getWorklist(db, request.query.type),
    );
  };
}
