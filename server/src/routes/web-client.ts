import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Issue #116 (docs/plans/03-connection-and-streaming.md, "Web client served
// by the home server"): opening http://<server>:8899/ in any browser *is*
// the client. This plugin serves the built frontend at / and falls back to
// index.html for any other page path, so a deep link or a reload lands on
// the app instead of a 404.
//
// Everything here is GET/HEAD and outside the API prefixes, which is what
// keeps it reachable without signing in once #112's auth gate lands — the
// sign-in page is itself served from here.

// Paths the client never owns. A miss under one of these is a real API 404
// and must stay JSON, never an HTML page: a fetch for a route an older
// server doesn't have should fail as `{ statusCode: 404 }`, not parse
// index.html as JSON and throw somewhere far from the cause.
const API_PREFIXES = ["/api", "/covers"];

// Added to every index.html this server hands out. src/config/serverHost.ts
// looks for it to decide the page's own origin is the server to talk to —
// a positive signal rather than an inference from import.meta.env.PROD or
// the hostname, both of which are also true of a Tauri bundle or
// app.legato.fm, where the page's origin is *not* a Legato server.
export const SERVED_BY_SERVER_MARKER = '<meta name="legato-server" content="same-origin">';

// Vite fingerprints everything it emits under assets/ (index-<hash>.js), so
// a file there never changes under the same name. Everything else —
// index.html above all, plus unhashed public/ files like favicon.png — has
// to be revalidated, or a browser keeps running last release's shell
// against this release's API.
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

export interface WebClientSource {
  // For the startup log line.
  description: string;
  // A readable path for a URL path ("/assets/index-abc.js"), or null.
  // Inside the compiled binary that path is a /$bunfs/ one; Bun.file()
  // reads both kinds the same way.
  resolve(urlPath: string): string | null;
}

// Filled by the module server/scripts/compile.ts generates: one
// `import … with { type: "file" }` per file in dist/, which is how
// `bun build --compile` embeds a file (the same reason
// migrations/manifest.generated.ts exists). That module runs before
// index.ts, so this is populated by the time webClientRoutes() reads it.
// Keyed by URL path. Empty in every non-compiled run.
const embeddedFiles = new Map<string, string>();

export function registerEmbeddedWebClient(files: Record<string, string>): void {
  for (const [urlPath, filePath] of Object.entries(files)) embeddedFiles.set(urlPath, filePath);
}

export function directorySource(dir: string): WebClientSource {
  const root = path.resolve(dir);
  return {
    description: `serving ${root}`,
    resolve(urlPath) {
      const full = path.resolve(root, `.${urlPath}`);
      // decodeURIComponent has already turned %2e%2e%2f into ../, so this
      // is the check that keeps a request inside dist/.
      if (!full.startsWith(root + path.sep)) return null;
      try {
        return statSync(full).isFile() ? full : null;
      } catch {
        return null;
      }
    },
  };
}

// The compiled binary always has an embedded copy. A source run
// (`bun src/index.ts`, `npx tauri dev`) falls back to the repo's own dist/
// if `npm run build` has produced one, so the same URL works in dev without
// a compile; it picks up a rebuild on the next request, no restart needed.
function resolveWebClientSource(): WebClientSource | null {
  if (embeddedFiles.size > 0) {
    return {
      description: `embedded (${embeddedFiles.size} files)`,
      resolve: (urlPath) => embeddedFiles.get(urlPath) ?? null,
    };
  }
  const repoDist = path.resolve(import.meta.dirname, "..", "..", "..", "dist");
  if (existsSync(path.join(repoDist, "index.html"))) return directorySource(repoDist);
  return null;
}

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// null for a path that isn't valid percent-encoding; that's a 404 like any
// other path nothing lives at.
function requestPath(url: string): string | null {
  try {
    return decodeURIComponent(url.split("?", 1)[0]);
  } catch {
    return null;
  }
}

// Only a page navigation gets the SPA shell. A missing /assets/index-old.js
// (a tab left open across an upgrade) must 404, not come back as HTML the
// browser then refuses as a script with a MIME error that hides the cause.
function wantsPage(request: FastifyRequest, pathname: string): boolean {
  return path.posix.extname(pathname) === "" || (request.headers.accept ?? "").includes("text/html");
}

async function sendFile(reply: FastifyReply, filePath: string, pathname: string) {
  const file = Bun.file(filePath);
  reply.type(file.type);
  reply.header("Cache-Control", pathname.startsWith("/assets/") ? IMMUTABLE : REVALIDATE);
  return reply.send(Buffer.from(await file.arrayBuffer()));
}

async function sendShell(reply: FastifyReply, indexPath: string) {
  const html = await Bun.file(indexPath).text();
  const marked = html.includes("</head>")
    ? html.replace("</head>", `${SERVED_BY_SERVER_MARKER}</head>`)
    : SERVED_BY_SERVER_MARKER + html;
  reply.type("text/html; charset=utf-8");
  reply.header("Cache-Control", REVALIDATE);
  return reply.send(marked);
}

export function webClientRoutes(source: WebClientSource | null = resolveWebClientSource()) {
  return async function routes(app: FastifyInstance) {
    app.log.info(
      source
        ? `web client: ${source.description}`
        : "web client: none (not embedded, and no dist/ next to server/ — run `npm run build`); / will 404",
    );

    // A wildcard, not a not-found handler: find-my-way always prefers a
    // registered route over `/*`, so every real API route and the websocket
    // win without this file knowing they exist. callNotFound() hands the rest to Fastify's default JSON 404.
    app.get("/*", async (request, reply) => {
      const pathname = requestPath(request.url);
      if (pathname === null || isApiPath(pathname) || !source) return reply.callNotFound();

      // /index.html itself goes through sendShell so it carries the marker
      // like every other route to the shell does.
      if (pathname !== "/index.html") {
        const filePath = source.resolve(pathname);
        if (filePath) return sendFile(reply, filePath, pathname);
      }

      const indexPath = source.resolve("/index.html");
      if (!indexPath) return reply.callNotFound();
      if (pathname !== "/index.html" && !wantsPage(request, pathname)) return reply.callNotFound();
      return sendShell(reply, indexPath);
    });
  };
}
