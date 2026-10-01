import { describe, expect, it } from "bun:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { cookieAttributes } from "./auth.js";

describe("cookieAttributes", () => {
  it("marks cookies Secure when the relay is served over https", () => {
    expect(cookieAttributes("https://auth.legato.fm")).toEqual({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
  });

  it("leaves Secure off for loopback http development, where a browser would refuse to store it", () => {
    expect(cookieAttributes("http://127.0.0.1:8901").secure).toBe(false);
  });

  it("leaves Secure off when no callback URL is configured (OAuth inactive)", () => {
    expect(cookieAttributes(undefined).secure).toBe(false);
  });

  // The attributes have to survive @fastify/cookie's serializer, on both
  // the set and the clear, or a logout over https leaves the Secure
  // session cookie in place.
  it("serializes Secure on both setting and clearing a cookie", async () => {
    const attrs = cookieAttributes("https://auth.legato.fm");
    const app = Fastify();
    await app.register(cookie);
    app.get("/set", async (_request, reply) => reply.setCookie("relay_session", "t", { ...attrs, maxAge: 60 }).send("ok"));
    app.get("/clear", async (_request, reply) => reply.clearCookie("relay_session", attrs).send("ok"));

    for (const url of ["/set", "/clear"]) {
      const res = await app.inject({ url });
      const header = String(res.headers["set-cookie"]);
      expect(header).toContain("Secure");
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Lax");
    }
    await app.close();
  });
});
