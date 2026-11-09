// The downloads behind fetch-release-media-binaries.mjs: every checksum,
// archive and API answer it fetches goes through download() or fetchText()
// here. A module of its own so release-fetch.spec.mjs can run them against a
// local server without starting the script's real fetch.
//
// Two ways a source has refused a release runner, each gone on a rerun a few
// minutes later:
//   * evermeet.cx answered the v0.1.0 run with HTTP 429. These hosts
//     rate-limit GitHub's shared runner addresses, and one refusal used to
//     fail the whole release.
//   * johnvansickle.com answered the v0.2.0 run with HTTP 200 and an HTML
//     page for both the .md5 and the archive (#443), a block or a challenge
//     page for datacenter addresses. The md5 check then failed with
//     "<!DOCTYPE" as the expected checksum, which pointed at the wrong cause.
//   * osxexperts.net failed the desktop build's first run (#129) before
//     answering at all: undici's bare "fetch failed", a reset connection or
//     a TLS or DNS hiccup. The same request went through moments later.
// No checksum, archive or API answer starts with "<", and no source labels
// one text/html (checked against all four on 2026-11-08), so either means a
// web page. A 429, a 5xx, a web page or a request that got no answer is
// asked again up to four more times, waiting as long as Retry-After asks
// (capped at a minute) or 5, 15, 30 and 60 seconds. Anything else fails at
// once.

import { createWriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

const WEB_PAGE = Symbol("web page");

function labelledHtml(res) {
  return /^\s*text\/html\b/i.test(res.headers.get("content-type") ?? "");
}

// trimStart() takes a byte order mark too.
function startsWithTag(text) {
  return text.trimStart().startsWith("<");
}

async function firstBytes(file, count) {
  const handle = await open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(count), 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function webPageError(url, tries) {
  const { host, pathname } = new URL(url);
  return new Error(
    `${host} sent a web page instead of ${path.posix.basename(pathname) || "the file"}, ${tries} times in a row (GET ${url}).\n` +
      `  It's probably blocking or challenging this runner's address, which a rerun a few minutes later usually gets past.\n` +
      `  Rerun the failed jobs: nothing is published before the release's publish step (docs/development.md, "When a release run fails").`,
  );
}

// `read` takes an answer that came back 2xx and returns what it holds, or
// WEB_PAGE to have it asked for again.
async function fetchWithRetry(url, retryDelaysMs, read) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt >= retryDelaysMs.length) throw err;
      const cause = err.cause?.code ?? err.cause?.message ?? err.message;
      console.log(`  [retry] GET ${url} -> ${cause}; trying again in ${Math.round(retryDelaysMs[attempt] / 1000)} s`);
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
      continue;
    }
    let refused;
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      refused = `HTTP ${res.status}`;
    } else if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GET ${url} -> HTTP ${res.status}`);
    } else {
      const value = await read(res);
      if (value !== WEB_PAGE) return value;
      refused = "a web page";
    }
    if (attempt >= retryDelaysMs.length) {
      throw refused === "a web page" ? webPageError(url, attempt + 1) : new Error(`GET ${url} -> ${refused}`);
    }
    const asked = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked * 1000, 60_000) : retryDelaysMs[attempt];
    console.log(`  [retry] GET ${url} -> ${refused}; trying again in ${Math.round(waitMs / 1000)} s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export async function download(url, destPath, { retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  await mkdir(path.dirname(destPath), { recursive: true });
  await fetchWithRetry(url, retryDelaysMs, async (res) => {
    if (!res.body) throw new Error(`GET ${url} -> HTTP ${res.status} with no body`);
    if (labelledHtml(res)) {
      await res.body.cancel();
      return WEB_PAGE;
    }
    // Written in full before it's looked at: a page is a few KB, and an
    // archive is never one.
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
    return startsWithTag((await firstBytes(destPath, 256)).toString("utf8")) ? WEB_PAGE : undefined;
  });
}

export async function fetchText(url, { retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  return fetchWithRetry(url, retryDelaysMs, async (res) => {
    if (labelledHtml(res)) {
      await res.body?.cancel();
      return WEB_PAGE;
    }
    const text = await res.text();
    return startsWithTag(text) ? WEB_PAGE : text;
  });
}
