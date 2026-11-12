import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { download, downloadFromFirst, fetchText } from "./release-fetch.mjs";

// Issue #443: johnvansickle.com answered a release runner with HTTP 200 and
// an HTML page for both the .md5 and the archive. A local server plays each
// answer here, and the retries wait no time at all.
const NO_WAIT = { retryDelaysMs: [0, 0] };
const PAGE = "<!DOCTYPE html>\n<html><head><title>Just a moment...</title></head></html>\n";
const XZ = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04, 0xe6, 0xd6, 0xb4, 0x46]);

// path -> what each request to it answers, in order; the last repeats.
let answers = new Map();
const requests = new Map();
let server;
let base;
let dir;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.set(req.url, (requests.get(req.url) ?? 0) + 1);
    const list = answers.get(req.url) ?? [{ status: 404, body: "not here" }];
    const answer = list[Math.min(requests.get(req.url) - 1, list.length - 1)];
    res.writeHead(answer.status ?? 200, { "content-type": answer.type ?? "application/octet-stream" });
    res.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(async () => {
  answers = new Map();
  requests.clear();
  dir = await mkdtemp(path.join(tmpdir(), "legato-release-fetch-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("a web page where a checksum belongs", () => {
  it("is asked for again, and the checksum that comes next is used", async () => {
    answers.set("/ffmpeg.tar.xz.md5", [
      { type: "text/html; charset=UTF-8", body: PAGE },
      { type: "application/x-xz", body: "2c90f87e960b0bee7274b1b37eb55ce7  ffmpeg.tar.xz\n" },
    ]);
    expect(await fetchText(`${base}/ffmpeg.tar.xz.md5`, NO_WAIT)).toBe("2c90f87e960b0bee7274b1b37eb55ce7  ffmpeg.tar.xz\n");
    expect(requests.get("/ffmpeg.tar.xz.md5")).toBe(2);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("-> a web page; trying again"));
  });

  it("fails after the last retry saying the source sent a web page, and to rerun the failed jobs", async () => {
    answers.set("/ffmpeg.tar.xz.md5", [{ type: "text/html", body: PAGE }]);
    const failure = fetchText(`${base}/ffmpeg.tar.xz.md5`, NO_WAIT);
    await expect(failure).rejects.toThrow(/sent a web page instead of ffmpeg\.tar\.xz\.md5, 3 times in a row/);
    await expect(failure).rejects.toThrow(/blocking or challenging this runner's address/);
    await expect(failure).rejects.toThrow(/Rerun the failed jobs: nothing is published before the release's publish step/);
    expect(requests.get("/ffmpeg.tar.xz.md5")).toBe(3);
  });

  it("is caught by its first character when it isn't labelled HTML", async () => {
    answers.set("/ffmpeg.tar.xz.md5", [{ type: "text/plain", body: `﻿\n  ${PAGE}` }]);
    await expect(fetchText(`${base}/ffmpeg.tar.xz.md5`, NO_WAIT)).rejects.toThrow(/sent a web page/);
  });
});

describe("a web page where an archive belongs", () => {
  it("is asked for again, and the archive that comes next is written", async () => {
    answers.set("/ffmpeg.tar.xz", [{ type: "text/html", body: PAGE }, { body: XZ }]);
    const dest = path.join(dir, "nested", "ffmpeg.tar.xz");
    await download(`${base}/ffmpeg.tar.xz`, dest, NO_WAIT);
    expect(await readFile(dest)).toEqual(XZ);
    expect(requests.get("/ffmpeg.tar.xz")).toBe(2);
  });

  it("fails the same way when it's sent as an archive", async () => {
    answers.set("/ffmpeg.tar.xz", [{ type: "application/x-xz", body: PAGE }]);
    await expect(download(`${base}/ffmpeg.tar.xz`, path.join(dir, "ffmpeg.tar.xz"), NO_WAIT)).rejects.toThrow(
      /sent a web page instead of ffmpeg\.tar\.xz, 3 times in a row[\s\S]*Rerun the failed jobs/,
    );
    expect(requests.get("/ffmpeg.tar.xz")).toBe(3);
  });
});

describe("other answers", () => {
  it("still retries a 429 or a 5xx, and still names the status when it gives up", async () => {
    answers.set("/limited.sha256", [{ status: 429, body: "slow down" }, { status: 503, body: "" }, { type: "text/plain", body: "abc  x.zip\n" }]);
    expect(await fetchText(`${base}/limited.sha256`, NO_WAIT)).toBe("abc  x.zip\n");
    answers.set("/down.zip", [{ status: 502, body: "" }]);
    await expect(download(`${base}/down.zip`, path.join(dir, "down.zip"), NO_WAIT)).rejects.toThrow(/-> HTTP 502$/);
    expect(requests.get("/down.zip")).toBe(3);
  });

  it("retries a request that got no answer at all, as when the connection drops (#129)", async () => {
    answers.set("/ffmpeg9arm.zip", [{ body: XZ }]);
    const realFetch = globalThis.fetch;
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((...args) => {
      calls++;
      if (calls === 1) return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }));
      return realFetch(...args);
    });
    const dest = path.join(dir, "ffmpeg9arm.zip");
    await download(`${base}/ffmpeg9arm.zip`, dest, NO_WAIT);
    expect(await readFile(dest)).toEqual(XZ);
    expect(calls).toBe(2);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("-> ECONNRESET; trying again"));
  });

  it("gives up on a request that never gets an answer, with the original error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchText(`${base}/never.md5`, NO_WAIT)).rejects.toThrow("fetch failed");
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("fails at once on a 404, without retrying", async () => {
    await expect(fetchText(`${base}/gone.md5`, NO_WAIT)).rejects.toThrow(/-> HTTP 404$/);
    expect(requests.get("/gone.md5")).toBe(1);
  });

  it("takes a JSON answer, which starts with a brace", async () => {
    answers.set("/releases/latest", [{ type: "application/json", body: '{"tag_name":"v1.6.0"}' }]);
    expect(JSON.parse(await fetchText(`${base}/releases/latest`, NO_WAIT)).tag_name).toBe("v1.6.0");
  });
});

// Issue #513: osxexperts.net timed out on runners until builds failed, so
// its zips come from a copy of our own first. Here "/copy/" plays the copy
// and "/host/" osxexperts.net.
describe("a copy of our own, then the source's host", () => {
  const ZIP = Buffer.from("PK\u0003\u0004 the pinned build");
  const OTHER = Buffer.from("PK\u0003\u0004 a different build");

  // What fetch-release-media-binaries.mjs does with each, minus the unzip:
  // the copy has to be the pinned build, the host's is taken either way.
  const sources = (copyRetries = [0, 0]) => [
    {
      name: "our copy",
      url: `${base}/copy/ffmpeg9arm-pin.zip`,
      dest: path.join(dir, "copy.zip"),
      retryDelaysMs: copyRetries,
      check: async (file) => {
        const bytes = await readFile(file);
        if (!bytes.equals(ZIP)) throw new Error("the extracted ffmpeg's sha256 is something else, not the pinned one");
        return { from: "copy", bytes };
      },
    },
    {
      name: "osxexperts.net",
      url: `${base}/host/ffmpeg9arm.zip`,
      dest: path.join(dir, "host.zip"),
      retryDelaysMs: [0, 0],
      check: async (file) => ({ from: "host", bytes: await readFile(file) }),
    },
  ];

  it("takes the copy, and never asks the host", async () => {
    answers.set("/copy/ffmpeg9arm-pin.zip", [{ body: ZIP }]);
    answers.set("/host/ffmpeg9arm.zip", [{ body: ZIP }]);
    expect(await downloadFromFirst(sources())).toEqual({ from: "copy", bytes: ZIP });
    expect(requests.get("/copy/ffmpeg9arm-pin.zip")).toBe(1);
    expect(requests.has("/host/ffmpeg9arm.zip")).toBe(false);
  });

  it("asks the host at once when there's no copy for this pin", async () => {
    answers.set("/host/ffmpeg9arm.zip", [{ body: ZIP }]);
    expect(await downloadFromFirst(sources())).toEqual({ from: "host", bytes: ZIP });
    expect(requests.get("/copy/ffmpeg9arm-pin.zip")).toBe(1);
    expect(requests.get("/host/ffmpeg9arm.zip")).toBe(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/\[fallback\] our copy didn't have it \(GET \S+ -> HTTP 404\); trying osxexperts\.net/),
    );
  });

  it("asks the host after the copy's own retries when the copy keeps refusing", async () => {
    answers.set("/copy/ffmpeg9arm-pin.zip", [{ status: 503, body: "" }]);
    answers.set("/host/ffmpeg9arm.zip", [{ body: ZIP }]);
    expect(await downloadFromFirst(sources([0]))).toEqual({ from: "host", bytes: ZIP });
    expect(requests.get("/copy/ffmpeg9arm-pin.zip")).toBe(2);
  });

  it("asks the host when the copy isn't the pinned build", async () => {
    answers.set("/copy/ffmpeg9arm-pin.zip", [{ body: OTHER }]);
    answers.set("/host/ffmpeg9arm.zip", [{ body: ZIP }]);
    expect(await downloadFromFirst(sources())).toEqual({ from: "host", bytes: ZIP });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("our copy didn't have it (the extracted ffmpeg's sha256 is something else"),
    );
  });

  it("takes a copy that answers after a dropped connection, without asking the host", async () => {
    answers.set("/copy/ffmpeg9arm-pin.zip", [{ body: ZIP }]);
    const realFetch = globalThis.fetch;
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((...args) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) }));
      }
      return realFetch(...args);
    });
    expect(await downloadFromFirst(sources())).toEqual({ from: "copy", bytes: ZIP });
    expect(requests.has("/host/ffmpeg9arm.zip")).toBe(false);
  });

  it("fails saying what each source did when neither has it", async () => {
    answers.set("/host/ffmpeg9arm.zip", [{ status: 502, body: "" }]);
    const failure = downloadFromFirst(sources());
    await expect(failure).rejects.toThrow(
      /^no source had it\.\n {2}our copy: GET \S+ -> HTTP 404\n {2}osxexperts\.net: GET \S+ -> HTTP 502$/,
    );
    expect(requests.get("/host/ffmpeg9arm.zip")).toBe(3);
  });
});
