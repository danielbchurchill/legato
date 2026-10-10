import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserById, getUserBySessionToken, sessionToken, type RelayUserRow } from "../accounts.js";
import {
  cancelUrl,
  LINK_REDEEM_FAILURE_MESSAGES,
  linkPath,
  mintLinkCode,
  parseLinkRedeem,
  parseLinkRequest,
  redeemLinkCode,
  returnUrl,
  type LinkQuery,
  type LinkRequest,
} from "../link-codes.js";
import { clientAddress, TokenLimiter } from "../rate-limit.js";
import { signServerToken, type SigningKeys } from "../signing-keys.js";
import type { Database } from "../sqlite.js";

// legato.fm/link (issue #325): where a home server's web client sends its
// owner to link that server to their account. The page there can't ask for
// a link token itself: it isn't signed in to legato.fm, and the session
// cookie would be third-party to it. So it comes here, top-level, and gets a
// one-time code back (link-codes.ts, migrations/0008_link_codes.sql).
//
// One page, drawn from the session and the request, like the claim page
// (claim-page.ts) and in the same whole-window form, DESIGN.md's owner-gate
// message: the wordmark, one sentence that says what's true and what to do,
// and the controls to do it. The colours are tokens.css's, copied, since
// this page is built and served apart from the app;
// src/styles/canvasCopies.spec.ts holds the copies to the tokens.
//
// It names the host the code goes back to, before anyone presses link, and
// it never goes there by itself. It can't be framed, sends no Referer, runs
// only its own script, and isn't cached.

// src/assets/brand/white-wordmark.svg with its fills set to currentColor,
// so the one copy takes the ink of either theme.
const WORDMARK = readFileSync(path.join(import.meta.dirname, "..", "assets", "wordmark.svg"), "utf8").replace(
  "<svg ",
  '<svg class="wordmark" role="img" aria-label="legato" ',
);

type Providers = { google: boolean; github: boolean };

export type LinkView =
  | { kind: "bad_request" }
  | { kind: "unavailable" }
  | { kind: "signed_out"; request: LinkRequest; providers: Providers }
  | { kind: "ready"; request: LinkRequest; user: RelayUserRow };

function escapeHtml(s: string): string {
  const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => escapes[c]!);
}

function account(user: RelayUserRow): string {
  const name = escapeHtml(user.display_name ?? user.email ?? "your account");
  return user.email && user.display_name ? `${name} (${escapeHtml(user.email)})` : name;
}

const PROVIDER_NAMES: Record<keyof Providers, string> = { google: "Google", github: "GitHub" };

function signInButtons(request: LinkRequest, providers: Providers): string {
  const returnTo = encodeURIComponent(linkPath(request));
  const buttons = (["github", "google"] as const)
    .filter((provider) => providers[provider])
    .map(
      (provider) =>
        `<a class="button secondary" href="/auth/${provider}?return_to=${returnTo}">sign in with ${PROVIDER_NAMES[provider].toLowerCase()}</a>`,
    );
  if (buttons.length === 0) return `<p class="quiet">legato.fm sign-in isn't set up on this service.</p>`;
  return `<div class="actions">${buttons.join("")}</div>`;
}

// The origin the code would go back to, as the one thing to check: scheme,
// host and port, since a host alone hides http against https, and which
// port.
function addressBlock(request: LinkRequest): string {
  return `<p class="address" aria-label="server address">${escapeHtml(request.returnTo.origin)}</p>`;
}

function content(view: LinkView): { title: string; body: string } {
  switch (view.kind) {
    case "bad_request":
      return {
        title: "That link isn't complete",
        body: "<p>Something was missing from the address that brought you here, so nothing was linked. Start again from your Legato server's Settings.</p>",
      };
    case "unavailable":
      return {
        title: "Linking isn't available yet",
        body: "<p>legato.fm can't link servers yet. Your server works without it.</p>",
      };
    case "signed_out":
      return {
        title: "Link your Legato server",
        body: `${addressBlock(view.request)}
    <p>Sign in to legato.fm to link the Legato server at this address to your account.</p>
    ${signInButtons(view.request, view.providers)}`,
      };
    case "ready":
      return {
        title: "Link your Legato server",
        body: `${addressBlock(view.request)}
    <p>Link the Legato server at this address to ${account(view.user)}?</p>
    <p class="quiet">That account can then open its library through legato.fm. Only link a server you own.</p>
    <div class="actions">
      <button class="button primary" type="button" data-action="link">link this server</button>
      <button class="button secondary" type="button" data-action="cancel">cancel</button>
    </div>
    <p class="quiet" role="status" data-status hidden></p>
    <button class="button link" type="button" data-action="sign-out">not you? sign out</button>`,
      };
  }
}

export function linkPage(view: LinkView, nonce: string): string {
  const { title, body } = content(view);
  // Only the ready view acts, and only with what this service checked.
  const request =
    view.kind === "ready"
      ? { server: view.request.serverId, return_to: view.request.returnTo.href, code_challenge: view.request.codeChallenge }
      : null;
  const cancel = view.kind === "ready" ? cancelUrl(view.request) : null;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <title>${escapeHtml(title)} · legato.fm</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --canvas: #0f1214;
      --ink: #f2efe9;
      --ink-2: #a9adaf;
      --ink-3: #74797c;
      --wash-2: rgb(255 255 255 / 0.09);
      --line-strong: rgb(255 255 255 / 0.16);
      --on-accent: #15111c;
      --accent-fill: linear-gradient(135deg, #bf68eb, #68b6eb);
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --canvas: #ebe6dc;
        --ink: #1c1915;
        --ink-2: #57514a;
        --ink-3: #7d766d;
        --wash-2: rgb(60 44 28 / 0.085);
        --line-strong: rgb(60 44 28 / 0.22);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 24px;
      background: var(--canvas);
      color: var(--ink);
      font: 400 14px/20px "Rubik Variable", Rubik, system-ui, sans-serif;
      text-align: center;
    }
    .wordmark { height: 40px; width: auto; margin-bottom: 12px; }
    h1 { margin: 0; font-size: 20px; line-height: 26px; font-weight: 500; letter-spacing: -0.01em; }
    p { margin: 0; max-width: 360px; }
    .quiet { color: var(--ink-2); }
    .address {
      max-width: 100%;
      font: 400 20px/26px "Sometype Mono Variable", "Sometype Mono", ui-monospace, monospace;
      overflow-wrap: anywhere;
    }
    .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; padding-top: 4px; }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 36px;
      padding: 0 16px;
      border: 0;
      border-radius: 999px;
      font: 500 13px/1 "Rubik Variable", Rubik, system-ui, sans-serif;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
    }
    .button:disabled { opacity: 0.4; cursor: default; }
    .primary { background-image: var(--accent-fill); color: var(--on-accent); }
    .primary:hover { filter: brightness(1.1); }
    .secondary { background: var(--wash-2); color: var(--ink); }
    .secondary:hover { background: var(--line-strong); }
    .link { height: auto; padding: 0; background: none; color: var(--ink-2); }
    .link:hover { color: var(--ink); }
    :focus-visible { outline: 3px solid color-mix(in srgb, var(--ink-3) 50%, transparent); outline-offset: 2px; }
  </style>
</head>
<body data-view="${view.kind}">
  ${WORDMARK}
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <script nonce="${nonce}">
    const request = ${JSON.stringify(request).replace(/</g, "\\u003c")};
    const cancel = ${JSON.stringify(cancel).replace(/</g, "\\u003c")};
    const status = document.querySelector("[data-status]");

    document.querySelector('[data-action="link"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const res = await fetch("/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }).catch(() => null);
      const answer = res ? await res.json().catch(() => ({})) : {};
      if (res?.ok && answer.redirect) return location.assign(answer.redirect);
      status.hidden = false;
      status.textContent = answer.error ?? "Couldn't reach legato.fm. Check your connection, then try again.";
      button.disabled = false;
    });

    // Back to the server with no code, saying it was cancelled.
    document.querySelector('[data-action="cancel"]')?.addEventListener("click", () => location.assign(cancel));

    document.querySelector('[data-action="sign-out"]')?.addEventListener("click", async () => {
      await fetch("/auth/logout", { method: "POST" }).catch(() => null);
      location.reload();
    });
  </script>
</body>
</html>`;
}

// Where a browser sign-in started from this page goes back to afterwards
// (routes/auth.ts). Only ever /link with a well-formed request, rebuilt from
// its checked parts, so the parameter can't send anyone anywhere else.
export function linkReturnPath(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  let url: URL;
  try {
    url = new URL(candidate, "http://relay.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://relay.invalid" || url.pathname !== "/link") return null;
  const request = parseLinkRequest(Object.fromEntries(url.searchParams));
  return request ? linkPath(request) : null;
}

// Every view of the page goes out with these.
function pageHeaders(reply: FastifyReply, nonce: string): void {
  reply
    .type("text/html")
    .header("Cache-Control", "no-store")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Frame-Options", "DENY")
    .header(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; ` +
        "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
}

// /link/redeem is called from the page the code went back to, at whatever
// origin that is, without credentials: the code and verifier are what
// authorize it. So any origin may ask, and the route itself checks that the
// asking origin is the one the code was sent to.
function allowAnyOrigin(request: FastifyRequest, reply: FastifyReply): void {
  reply.header("Vary", "Origin");
  const origin = request.headers.origin;
  if (!origin) return;
  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Access-Control-Allow-Methods", "POST");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
  reply.header("Access-Control-Max-Age", "600");
}

export function linkPageRoutes(
  db: Database,
  options: { providers: Providers; signingKeys: SigningKeys | null; issuer: string | undefined; limiter?: TokenLimiter },
) {
  const { signingKeys, issuer } = options;
  const ownOrigin = issuer ? new URL(issuer).origin : null;
  // Its own, so wrong link codes never slow anyone's sign-in at /auth/token,
  // and per address only, as every TokenLimiter is (see /link/redeem below).
  const limiter = options.limiter ?? new TokenLimiter();

  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: LinkQuery }>("/link", async (request, reply) => {
      const nonce = randomBytes(16).toString("base64");
      pageHeaders(reply, nonce);
      const link = parseLinkRequest(request.query);
      if (!link) {
        reply.code(400);
        return linkPage({ kind: "bad_request" }, nonce);
      }
      if (!signingKeys || !issuer) {
        reply.code(503);
        return linkPage({ kind: "unavailable" }, nonce);
      }
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) return linkPage({ kind: "signed_out", request: link, providers: options.providers }, nonce);
      return linkPage({ kind: "ready", request: link, user }, nonce);
    });

    // The page's link button, with the session cookie. SameSite=Lax keeps
    // other sites' pages from sending it, but legato.fm and its subdomains
    // count as the same site, so a request that says where it's from has to
    // be from this service's own page, as /pair/claim requires.
    app.post<{ Body: LinkQuery | null }>("/link", async (request, reply) => {
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) {
        reply.code(401);
        return { error: "Sign in to legato.fm first.", reason: "signed_out" };
      }
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== ownOrigin) {
        reply.code(403);
        return { error: "Link a server from legato.fm's own link page.", reason: "cross_origin" };
      }
      if (!signingKeys || !issuer) {
        reply.code(503);
        return { error: "legato.fm can't link servers yet: this relay doesn't sign server tokens.", reason: "signing_not_configured" };
      }
      const link = parseLinkRequest(request.body);
      if (!link) {
        reply.code(400);
        return { error: "That link request isn't complete. Start again from your server's Settings.", reason: "bad_request" };
      }
      const minted = mintLinkCode(db, user.id, link, signingKeys.linkOriginKeys[0]!);
      if (!minted.ok) {
        reply.code(429);
        return {
          error: "This account has too many links waiting to finish. Wait five minutes for them to expire, then try again.",
          reason: "too_many",
        };
      }
      request.log.info(`link: account ${user.id} is linking server ${link.serverId} from its web client`);
      return { redirect: returnUrl(link, minted.code) };
    });

    app.options("/link/redeem", async (request, reply) => {
      allowAnyOrigin(request, reply);
      return reply.code(204).send();
    });

    // A `link` token for the account and server the code was minted for,
    // marked for a tunnel credential (signing-keys.ts). The credential
    // itself is minted only when the server reports the link.
    //
    // A code is 32 random bytes, spent on its first try and useless without
    // its verifier, so guessing gains nothing. The brake (rate-limit.ts) is
    // only there to keep a script from trying at speed, so it counts only
    // what a guess looks like: a well-formed code this relay doesn't know,
    // or one that's expired. A request that couldn't be a code is refused
    // before it, and a used code or a wrong verifier is a client retrying
    // or a code already burnt, not a guess. It's per address only: a cap
    // across all addresses would let a few of them lock every owner out of
    // linking, for nothing.
    app.post<{ Body: { code?: unknown; code_verifier?: unknown } | null }>("/link/redeem", async (request, reply) => {
      allowAnyOrigin(request, reply);
      const input = parseLinkRedeem(request.body);
      if (!input) {
        reply.code(400);
        return { error: LINK_REDEEM_FAILURE_MESSAGES.malformed, reason: "malformed" };
      }
      const address = clientAddress(request.headers, request.ip);
      const retryAfter = limiter.retryAfterSeconds(address);
      if (retryAfter > 0) {
        reply.code(429).header("Retry-After", String(retryAfter));
        return {
          error: `Too many failed link attempts from this address. Try again in ${retryAfter} seconds.`,
          reason: "rate_limited",
        };
      }
      if (!signingKeys || !issuer) {
        reply.code(503);
        return { error: "legato.fm can't link servers yet: this relay doesn't sign server tokens.", reason: "signing_not_configured" };
      }
      const result = redeemLinkCode(db, { ...input, origin: request.headers.origin }, signingKeys.linkOriginKeys);
      if (!result.ok) {
        if (result.reason === "not_found" || result.reason === "expired") limiter.recordFailure(address);
        reply.code(400);
        return { error: LINK_REDEEM_FAILURE_MESSAGES[result.reason], reason: result.reason };
      }
      limiter.recordSuccess(address);
      // The account was deleted after the code was minted.
      const user = getUserById(db, result.relayUserId);
      if (!user) {
        reply.code(400);
        return { error: LINK_REDEEM_FAILURE_MESSAGES.not_found, reason: "not_found" };
      }
      const issued = signServerToken(signingKeys, { issuer, user, serverId: result.serverId, scope: "link", tunnel: true });
      return { token: issued.token, expiresAt: issued.expiresAt.toISOString(), scope: issued.scope };
    });
  };
}
