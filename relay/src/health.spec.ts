import { describe, expect, it } from "bun:test";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";

describe("health check", () => {
  it("returns 200 with a trivial JSON body, no auth required", async () => {
    const app = buildApp({ db: openDb(":memory:") });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
