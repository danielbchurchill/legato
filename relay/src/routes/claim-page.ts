import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { getUserBySessionToken, sessionToken, type RelayUserRow } from "../accounts.js";
import { normalizeCode } from "../claimCode.js";
import { claimStatus } from "../pairing.js";
import { SERVER_ID_PATTERN } from "../signing-keys.js";
import type { Database } from "../sqlite.js";
import { CLAIM_FAILURE_MESSAGES } from "./pair.js";

// legato.fm/claim (issue #237): where the QR code on a headless server's
// /setup page goes. legato.fm itself is a static site, so its /claim
// redirects here with the query string intact (site/public/_redirects).
// The QR carries the server's id as well as its code (issue #324), and a
// claim is for that server only (pairing.ts). A QR without one is from a
// server too old to claim, and the page says to update it.
//
// One page, drawn on this service from the session and the code's row in
// pairing_codes, so a reload always shows where things stand. The script
// at the bottom only claims (POST /pair/claim), signs out, and polls while
// it waits for the server, reloading when the answer changes.
//
// It follows DESIGN.md's whole-window message (the app's owner gate): the
// wordmark, one sentence that says what's true and what to do, and the
// controls to do it. The colours are tokens.css's, copied, since this page
// is built and served apart from the app; src/styles/canvasCopies.spec.ts
// holds the copies to the tokens. It follows the system theme, as legato.fm
// does.

// src/assets/brand/white-wordmark.svg with its fills set to currentColor,
// so the one copy takes the ink of either theme.
const WORDMARK = readFileSync(path.join(import.meta.dirname, "..", "assets", "wordmark.svg"), "utf8").replace(
  "<svg ",
  '<svg class="wordmark" role="img" aria-label="legato" ',
);

type Providers = { google: boolean; github: boolean };

export type ClaimView =
  | { kind: "bad_code" }
  | { kind: "outdated_server" }
  | { kind: "unavailable" }
  | { kind: "signed_out"; code: string; server: string; providers: Providers }
  | { kind: "ready" | "pending" | "picked_up" | "expired" | "taken" | "used"; code: string; server: string; user: RelayUserRow };

function escapeHtml(s: string): string {
  const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => escapes[c]!);
}

function accountName(user: RelayUserRow): string {
  return escapeHtml(user.display_name ?? user.email ?? "your account");
}

function account(user: RelayUserRow): string {
  const name = accountName(user);
  return user.email && user.display_name ? `${name} (${escapeHtml(user.email)})` : name;
}

const PROVIDER_NAMES: Record<keyof Providers, string> = { google: "Google", github: "GitHub" };

// This page, for a code and the server showing it. Both are checked before
// they get here, so neither needs escaping.
function claimPath(code: string, server: string): string {
  return `/claim?code=${code}&server=${server}`;
}

function signInButtons(code: string, server: string, providers: Providers): string {
  const returnTo = encodeURIComponent(claimPath(code, server));
  const buttons = (["github", "google"] as const)
    .filter((provider) => providers[provider])
    .map(
      (provider) =>
        `<a class="button secondary" href="/auth/${provider}?return_to=${returnTo}">sign in with ${PROVIDER_NAMES[provider].toLowerCase()}</a>`,
    );
  if (buttons.length === 0) return `<p class="quiet">legato.fm sign-in isn't set up on this service.</p>`;
  return `<div class="actions">${buttons.join("")}</div>`;
}

const SIGN_OUT = `<button class="button link" type="button" data-action="sign-out">not you? sign out</button>`;

function codeBlock(code: string): string {
  return `<p class="code" aria-label="setup code">${escapeHtml(code)}</p>`;
}

// Title, then the body; every view says what's true and what to do next.
function content(view: ClaimView): { title: string; body: string } {
  switch (view.kind) {
    case "bad_code":
      return { title: "That isn't a setup link", body: `<p>${CLAIM_FAILURE_MESSAGES.bad_code}</p>` };
    case "outdated_server":
      return {
        title: "Update this server first",
        body: `<p>${CLAIM_FAILURE_MESSAGES.outdated_server}</p>
    <p class="quiet">It works without legato.fm in the meantime: create its owner on its /setup page.</p>`,
      };
    case "unavailable":
      return {
        title: "Claiming isn't available yet",
        body: "<p>legato.fm can't link servers yet. Your server works without it: create its owner on its /setup page.</p>",
      };
    case "signed_out":
      return {
        title: "Claim this server",
        body: `${codeBlock(view.code)}
    <p>Sign in to legato.fm to claim the Legato server showing this code for your account, so you can reach it from anywhere.</p>
    ${signInButtons(view.code, view.server, view.providers)}`,
      };
    case "ready":
      return {
        title: "Claim this server",
        body: `${codeBlock(view.code)}
    <p>Claim the Legato server showing this code for ${account(view.user)}?</p>
    <p class="quiet">Nothing is linked yet. Your server picks the claim up while its /setup page is open, and you choose there whether to link this account when you create its owner.</p>
    <div class="actions"><button class="button primary" type="button" data-action="claim">claim this server</button></div>
    <p class="quiet" role="status" data-status hidden></p>
    ${SIGN_OUT}`,
      };
    case "pending":
      return {
        title: "Claimed",
        body: `${codeBlock(view.code)}
    <p>Waiting for your server to pick up the claim for ${accountName(view.user)}.</p>
    <p class="quiet">Keep the server's /setup page open: it checks with legato.fm every few seconds while it's open. If the code there has changed, scan the new one.</p>`,
      };
    case "picked_up":
      return {
        title: "Your server picked it up",
        body: `${codeBlock(view.code)}
    <p>Finish on the server's /setup page: choose “create owner and link ${accountName(view.user)}”.</p>
    <p class="quiet">If the owner isn't created within ten minutes, the claim lapses and nothing is linked. You can close this page.</p>`,
      };
    case "expired":
      return {
        title: "This claim expired",
        body: `${codeBlock(view.code)}
    <p>Your server didn't pick it up within ten minutes, so nothing was claimed.</p>
    <p class="quiet">Setup codes change every ten minutes. Open the server's /setup page and scan the code it shows now.</p>`,
      };
    case "taken":
      return { title: "Already claimed", body: `${codeBlock(view.code)}\n    <p>${CLAIM_FAILURE_MESSAGES.taken}</p>` };
    case "used":
      return { title: "Already used", body: `${codeBlock(view.code)}\n    <p>${CLAIM_FAILURE_MESSAGES.used}</p>` };
  }
}

// The page's one style and one script, apart from the page so its policy
// can name them by hash (issue #324). The script reads the code and the
// server off the body rather than having them written in, so both are the
// same on every page and the policy is too.
const STYLE = `
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
    .code {
      font: 400 30px/36px "Sometype Mono Variable", "Sometype Mono", ui-monospace, monospace;
      letter-spacing: 0.08em;
      font-variant-numeric: tabular-nums;
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
  `;

const SCRIPT = `
    const code = document.body.dataset.code ?? null;
    const server = document.body.dataset.server ?? null;
    const view = document.body.dataset.view;
    const status = document.querySelector("[data-status]");

    document.querySelector('[data-action="claim"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const res = await fetch("/pair/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, server }),
      }).catch(() => null);
      if (res?.ok) return location.reload();
      const answer = res ? await res.json().catch(() => ({})) : {};
      // Taken or used since the page loaded: the reload says which.
      if (answer.reason === "taken" || answer.reason === "used") return location.reload();
      status.hidden = false;
      status.textContent = answer.error ?? "Couldn't reach legato.fm. Check your connection, then try again.";
      button.disabled = false;
    });

    document.querySelector('[data-action="sign-out"]')?.addEventListener("click", async () => {
      await fetch("/auth/logout", { method: "POST" }).catch(() => null);
      location.reload();
    });

    // Waiting on the server: reload once the claim is picked up or expires.
    if (view === "pending") {
      setInterval(async () => {
        const res = await fetch("/pair/claim?code=" + encodeURIComponent(code)).catch(() => null);
        const answer = res?.ok ? await res.json() : null;
        if (answer && answer.status !== "pending") location.reload();
      }, 3000);
    }
  `;

const hashSource = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

// Nothing on the page runs, loads or styles but those two, and its script
// only talks to this service. Where it can be framed, where a form could
// submit and what its base URL is don't fall back to default-src, so they're
// shut by name.
export const CLAIM_PAGE_CSP = [
  "default-src 'none'",
  `script-src ${hashSource(SCRIPT)}`,
  `style-src ${hashSource(STYLE)}`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function claimPage(view: ClaimView): string {
  const { title, body } = content(view);
  const claim = "code" in view ? ` data-code="${escapeHtml(view.code)}" data-server="${escapeHtml(view.server)}"` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <title>${escapeHtml(title)} · legato.fm</title>
  <style>${STYLE}</style>
</head>
<body data-view="${view.kind}"${claim}>
  ${WORDMARK}
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <script>${SCRIPT}</script>
</body>
</html>`;
}

// Where a browser sign-in started from the claim page goes back to
// afterwards (routes/auth.ts). Only ever this page, a code and a server id,
// rebuilt from the parts, so the parameter can't send anyone anywhere else.
// One with a code and no server id at all is from a sign-in that started
// before this relay knew about server ids (#324). It goes back to the page
// too, which asks for the server to be updated, rather than to the generic
// "signed in" page that would leave its claim nowhere.
export function claimReturnPath(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  let url: URL;
  try {
    url = new URL(candidate, "http://relay.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://relay.invalid" || url.pathname !== "/claim") return null;
  const code = normalizeCode(url.searchParams.get("code"));
  const server = url.searchParams.get("server");
  if (!code) return null;
  if (!server) return `/claim?code=${code}`;
  return SERVER_ID_PATTERN.test(server) ? claimPath(code, server) : null;
}

export function claimPageRoutes(db: Database, options: { providers: Providers; signingAvailable: boolean }) {
  return async function routes(app: FastifyInstance) {
    app.get<{ Querystring: { code?: string; server?: string } }>("/claim", async (request, reply) => {
      reply.type("text/html").header("Cache-Control", "no-store").header("Content-Security-Policy", CLAIM_PAGE_CSP);
      const code = normalizeCode(request.query.code);
      // A link with a server id that isn't one is as broken as a bad code;
      // one with none is from a server that predates the id.
      const { server } = request.query;
      if (!code || (server && !SERVER_ID_PATTERN.test(server))) {
        reply.code(400);
        return claimPage({ kind: "bad_code" });
      }
      if (!server) {
        reply.code(400);
        return claimPage({ kind: "outdated_server" });
      }
      if (!options.signingAvailable) {
        reply.code(503);
        return claimPage({ kind: "unavailable" });
      }
      const token = sessionToken(request);
      const user = token ? getUserBySessionToken(db, token) : null;
      if (!user) return claimPage({ kind: "signed_out", code, server, providers: options.providers });
      const status = claimStatus(db, user.id, code);
      return claimPage({ kind: status === "none" ? "ready" : status, code, server, user });
    });
  };
}
