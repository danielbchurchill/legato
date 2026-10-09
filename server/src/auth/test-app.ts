// Test-only: the real server's plugin stack and route table, minus the
// listen() and background work index.ts also starts. Not a *.spec.ts, so
// `bun test` never runs it as a suite of its own.
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../sqlite.js";
import { registerRoutes } from "../routes/register.js";
import { installClientAddress } from "./clientAddress.js";
import { installAuthGate } from "./gate.js";
import { hasLegatoIdentity, installLegatoIdentity, LegatoIdentity } from "./legatoIdentity.js";

export type RegisteredRoute = { method: string; url: string };

// What a spec's server gets for legato.fm when it hasn't installed its own:
// the real origin, so URLs read as they would in production, and a fetch
// that never leaves the machine. Since #237 an open /setup page asks
// legato.fm whether its code was claimed, and a spec must never do that.
const offline = (async () => {
  throw new Error("specs never contact legato.fm");
}) as unknown as typeof fetch;

export async function buildTestApp(db: Database): Promise<{ app: FastifyInstance; routes: RegisteredRoute[] }> {
  if (!hasLegatoIdentity(db)) installLegatoIdentity(db, new LegatoIdentity(db, { fetch: offline }));
  const app = Fastify();
  const routes: RegisteredRoute[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });
  await app.register(cookie);
  await app.register(websocket);
  installClientAddress(app);
  installAuthGate(app, db);
  await registerRoutes(app, db);
  return { app, routes };
}

// A request body plus the headers a browser on this machine would send.
export const LOCAL_PAGE = { origin: "http://127.0.0.1:5173", host: "127.0.0.1:8899" };

export async function createOwnerForTest(app: FastifyInstance, password = "correct horse battery") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/owner",
    headers: LOCAL_PAGE,
    payload: { password },
  });
  if (res.statusCode !== 201) throw new Error(`owner creation failed: ${res.statusCode} ${res.body}`);
  return res.json() as { token: string; mediaTicket: string; expiresAt: string };
}
