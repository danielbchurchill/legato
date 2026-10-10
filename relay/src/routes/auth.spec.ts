import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { cookieAttributes, SUCCESS_PAGE_STYLE } from "./auth.js";
import { buildApp, DEFAULT_PAGE_CSP } from "../app.js";
import { openDb } from "../db.js";
import type { Database } from "../sqlite.js";

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

// The native (desktop) sign-in, end to end through the real routes, with
// only the provider's token exchange stubbed. No real client id or secret
// is involved: the config below is placeholder text, and the stub never
// reaches Google or GitHub.
describe("native sign-in (issue #215)", () => {
  const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const REDIRECT = "http://127.0.0.1:53682/callback";
  const CONFIG = {
    googleClientId: "test-google-id",
    googleClientSecret: "test-google-secret",
    githubClientId: "test-github-id",
    githubClientSecret: "test-github-secret",
    callbackBaseUrl: "https://auth.example",
  };

  let db: Database;
  let app: FastifyInstance;
  let exchangeCalls: string[];

  beforeEach(async () => {
    db = openDb(":memory:");
    exchangeCalls = [];
    const stub = async (code: string) => {
      exchangeCalls.push(code);
      if (code === "provider-down") throw new Error("stubbed provider failure");
      return { providerUserId: "gh-42", email: "rowan@example.com", displayName: "Rowan", avatarUrl: null };
    };
    app = buildApp({ db, auth: { config: CONFIG, exchange: { google: stub, github: stub } } });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function startQuery(overrides: Record<string, string | undefined> = {}): string {
    const params: Record<string, string> = {};
    const all = { redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", ...overrides };
    for (const [key, value] of Object.entries(all)) if (value !== undefined) params[key] = value;
    return new URLSearchParams(params).toString();
  }

  // Plays the browser: start, then come back from the provider with the
  // state the relay put in the provider URL and the cookie it set.
  async function signInThroughBrowser(
    provider: "github" | "google" = "github",
    callback: Record<string, string> = { code: "provider-code" },
  ) {
    const start = await app.inject({ url: `/auth/${provider}?${startQuery()}` });
    expect(start.statusCode).toBe(302);
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const stateCookie = start.cookies.find((c) => c.name === "relay_oauth_state")!;
    const query = new URLSearchParams({ state, ...callback });
    return app.inject({
      url: `/auth/${provider}/callback?${query}`,
      cookies: { relay_oauth_state: stateCookie.value },
    });
  }

  async function codeFromCallback(provider: "github" | "google" = "github"): Promise<string> {
    const callback = await signInThroughBrowser(provider);
    expect(callback.statusCode).toBe(302);
    const location = new URL(String(callback.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    return location.searchParams.get("code")!;
  }

  const redeem = (body: Record<string, unknown>, remoteAddress?: string) =>
    app.inject({ method: "POST", url: "/auth/token", payload: body, ...(remoteAddress ? { remoteAddress } : {}) });

  it("redirects the browser to the loopback with a code, sets no browser session, and the code redeems for a bearer token", async () => {
    const callback = await signInThroughBrowser();
    expect(callback.statusCode).toBe(302);
    expect(callback.cookies.find((c) => c.name === "relay_session")).toBeUndefined();
    const code = new URL(String(callback.headers.location)).searchParams.get("code")!;

    const res = await redeem({ code, code_verifier: VERIFIER, redirect_uri: REDIRECT });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; expiresAt: string; user: { displayName: string; provider: string } };
    expect(body.user).toMatchObject({ displayName: "Rowan", provider: "github" });

    const me = await app.inject({ url: "/auth/me", headers: { authorization: `Bearer ${body.token}` } });
    expect((me.json() as { user: { email: string } }).user.email).toBe("rowan@example.com");

    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${body.token}` } });
    expect(logout.statusCode).toBe(200);
    const after = await app.inject({ url: "/auth/me", headers: { authorization: `Bearer ${body.token}` } });
    expect((after.json() as { user: unknown }).user).toBeNull();
  });

  it("works the same through Google", async () => {
    const code = await codeFromCallback("google");
    expect((await redeem({ code, code_verifier: VERIFIER, redirect_uri: REDIRECT })).statusCode).toBe(200);
  });

  it("keeps the browser sign-in exactly as it was: cookie, success page, no redirect", async () => {
    const start = await app.inject({ url: "/auth/github" });
    expect(start.statusCode).toBe(302);
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const stateCookie = start.cookies.find((c) => c.name === "relay_oauth_state")!;
    expect(stateCookie.secure).toBe(true);

    const callback = await app.inject({
      url: `/auth/github/callback?code=provider-code&state=${state}`,
      cookies: { relay_oauth_state: stateCookie.value },
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain("Signed in as Rowan");
    const session = callback.cookies.find((c) => c.name === "relay_session")!;
    expect(session.secure).toBe(true);
    expect(session.httpOnly).toBe(true);

    const me = await app.inject({ url: "/auth/me", cookies: { relay_session: session.value } });
    expect((me.json() as { user: { displayName: string } }).user.displayName).toBe("Rowan");
  });

  // Issue #324: every HTML page has a policy, whether or not it sets one.
  it("sends the success page under the default policy, which allows its one style and nothing more", async () => {
    const start = await app.inject({ url: "/auth/github" });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const callback = await app.inject({
      url: `/auth/github/callback?code=provider-code&state=${state}`,
      cookies: { relay_oauth_state: start.cookies.find((c) => c.name === "relay_oauth_state")!.value },
    });
    expect(String(callback.headers["content-type"])).toStartWith("text/html");
    expect(callback.headers["content-security-policy"]).toBe(DEFAULT_PAGE_CSP);
    expect(DEFAULT_PAGE_CSP).toStartWith("default-src 'none';");
    expect(DEFAULT_PAGE_CSP).toContain("frame-ancestors 'none'");
    // Nothing on it that policy would block: no script, stylesheet, handler
    // or style attribute, and one <style>, the one it names by hash.
    expect(callback.body).not.toMatch(/<(script|link|img)\b|\s(on[a-z]+|style)=/);
    const styles = [...callback.body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
    expect(styles).toEqual([SUCCESS_PAGE_STYLE]);
    expect(DEFAULT_PAGE_CSP).toContain(`style-src 'sha256-${createHash("sha256").update(styles[0]!).digest("base64")}';`);
    expect(DEFAULT_PAGE_CSP).not.toContain("script-src");
    expect(DEFAULT_PAGE_CSP).not.toContain("unsafe");

    // JSON isn't a page, and a page with its own policy keeps it.
    expect((await app.inject({ url: "/health" })).headers["content-security-policy"]).toBeUndefined();
    const claim = await app.inject({ url: "/claim?code=K7QM-4XRD&server=0123456789abcdef0123456789abcdef" });
    expect(String(claim.headers["content-security-policy"])).toContain("script-src 'sha256-");
  });

  // routes/relay.ts sets /relay's sandbox on the raw response. Fastify's
  // reply.hasHeader sees that too, so the default policy never replaces it,
  // even on HTML Fastify itself sends there.
  it("keeps a policy set on the raw response, as /relay's sandbox is", async () => {
    const sandboxed = buildApp({ db: openDb(":memory:") });
    sandboxed.get("/sandboxed", async (_request, reply) => {
      reply.raw.setHeader("content-security-policy", "sandbox");
      return reply.type("text/html").send("<p>from a home server</p>");
    });
    const res = await sandboxed.inject({ url: "/sandboxed" });
    await sandboxed.close();
    expect(res.headers["content-security-policy"]).toBe("sandbox");
  });

  it("rejects a non-loopback redirect before the provider is ever involved", async () => {
    for (const redirect of ["https://evil.example/callback", "http://localhost:53682/callback", "http://127.0.0.1:53682/elsewhere"]) {
      const res = await app.inject({ url: `/auth/github?${startQuery({ redirect_uri: redirect })}` });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain("can only return to this computer");
      expect(res.cookies.find((c) => c.name === "relay_oauth_state")).toBeUndefined();
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM relay_native_requests").get()).toEqual({ n: 0 });
  });

  it("rejects plain PKCE", async () => {
    const res = await app.inject({ url: `/auth/github?${startQuery({ code_challenge_method: "plain" })}` });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("code_challenge_method must be S256. Plain PKCE isn't accepted.");
  });

  it("rejects a wrong verifier, and the code is spent afterwards", async () => {
    const code = await codeFromCallback();
    const wrong = await redeem({ code, code_verifier: "w".repeat(43), redirect_uri: REDIRECT });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: "invalid_grant", reason: "mismatch" });

    const retry = await redeem({ code, code_verifier: VERIFIER, redirect_uri: REDIRECT });
    expect(retry.json()).toMatchObject({ reason: "used" });
  });

  it("rejects a reused code", async () => {
    const code = await codeFromCallback();
    expect((await redeem({ code, code_verifier: VERIFIER, redirect_uri: REDIRECT })).statusCode).toBe(200);
    const again = await redeem({ code, code_verifier: VERIFIER, redirect_uri: REDIRECT });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ reason: "used", message: "This sign-in code was already used. Start sign-in again from Legato." });
  });

  it("rejects an expired code", async () => {
    const code = await codeFromCallback();
    db.prepare("UPDATE relay_auth_codes SET expires_at = datetime('now', '-1 second')").run();
    const res = await redeem({ code, code_verifier: VERIFIER, redirect_uri: REDIRECT });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ reason: "expired" });
  });

  it("rejects a redirect_uri that isn't exactly the one the code was sent to", async () => {
    const code = await codeFromCallback();
    const res = await redeem({ code, code_verifier: VERIFIER, redirect_uri: "http://[::1]:53682/callback" });
    expect(res.json()).toMatchObject({ reason: "mismatch" });
  });

  it("replays nothing: a second callback with the same state gets no code", async () => {
    const start = await app.inject({ url: `/auth/github?${startQuery()}` });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const stateCookie = start.cookies.find((c) => c.name === "relay_oauth_state")!;
    const hit = () =>
      app.inject({ url: `/auth/github/callback?code=c&state=${state}`, cookies: { relay_oauth_state: stateCookie.value } });
    expect((await hit()).statusCode).toBe(302);
    // The pending row is gone, so the replay falls to the browser path.
    expect((await hit()).statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM relay_auth_codes").get()).toEqual({ n: 1 });
  });

  it("sends a provider-side cancel straight back to the waiting app", async () => {
    const res = await signInThroughBrowser("github", { error: "access_denied" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${REDIRECT}?error=access_denied`);
    expect(exchangeCalls).toEqual([]);
  });

  it("sends a provider exchange failure back to the app instead of a 500 in the browser", async () => {
    const res = await signInThroughBrowser("github", { code: "provider-down" });
    expect(res.headers.location).toBe(`${REDIRECT}?error=provider_error`);
  });

  it("still refuses a callback with a forged state, native or not", async () => {
    await app.inject({ url: `/auth/github?${startQuery()}` });
    const res = await app.inject({ url: "/auth/github/callback?code=c&state=forged", cookies: { relay_oauth_state: "other" } });
    expect(res.statusCode).toBe(400);
  });

  it("rate-limits failed redemptions per address, with Retry-After", async () => {
    const bad = () => redeem({ code: "guess", code_verifier: VERIFIER, redirect_uri: REDIRECT }, "203.0.113.9");
    for (let i = 0; i < 5; i++) expect((await bad()).statusCode).toBe(400);
    const limited = await bad();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    // Another address isn't punished for that one's guesses.
    const code = await codeFromCallback();
    const ok = await redeem({ code, code_verifier: VERIFIER, redirect_uri: REDIRECT }, "198.51.100.4");
    expect(ok.statusCode).toBe(200);
  });

  it("answers CORS for the desktop origins only, and never allows credentials", async () => {
    for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://127.0.0.1:5181"]) {
      const pre = await app.inject({
        method: "OPTIONS",
        url: "/auth/token",
        headers: { origin, "access-control-request-method": "POST" },
      });
      expect(pre.statusCode).toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBe(origin);
      expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
    }
    const foreign = await app.inject({ url: "/auth/me", headers: { origin: "https://evil.example" } });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
    // The browser-only routes get no CORS at all.
    const start = await app.inject({ url: "/auth/github", headers: { origin: "tauri://localhost" } });
    expect(start.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
