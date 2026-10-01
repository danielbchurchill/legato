import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../sqlite.js";
import { openDb } from "../db.js";
import {
  CHECK_INTERVAL_MS,
  RELEASES_URL,
  UPDATE_CHECK_SETTING,
  checkForUpdates,
  isNewerVersion,
  pickLatestStable,
  readUpdateStatus,
  type FetchLike,
  type UpdateCheckOptions,
} from "./check.js";
import { resolveInstallChannel } from "./installChannel.js";

// Issue #110. Every test hands checkForUpdates a fake fetch, so nothing here
// touches the network; `calls` records what the server would have sent.

let db: Database;
let calls: { url: string; init: RequestInit | undefined }[];
let clock: Date;

beforeEach(() => {
  db = openDb(":memory:");
  calls = [];
  clock = new Date("2026-10-01T09:00:00Z");
});

function release(tag: string, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/r/${tag}`, ...extra };
}

function respondWith(status: number, body: unknown = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
}

function options(fetchFn: FetchLike, overrides: Partial<UpdateCheckOptions> = {}): UpdateCheckOptions {
  return { fetch: fetchFn, version: "0.3.0", env: {}, now: () => clock, ...overrides };
}

describe("checkForUpdates", () => {
  it("reports a newer stable release", async () => {
    const opts = options(respondWith(200, [release("v0.4.0"), release("v0.3.0")]));

    expect(await checkForUpdates(db, opts)).toBe("checked");
    expect(readUpdateStatus(db, opts)).toEqual({
      check: "on",
      latestVersion: "0.4.0",
      available: true,
      releaseUrl: "https://github.com/r/v0.4.0",
      checkedAt: clock.toISOString(),
    });
  });

  it("reports nothing available when the newest release is the running version", async () => {
    const opts = options(respondWith(200, [release("v0.3.0")]));

    await checkForUpdates(db, opts);
    const status = readUpdateStatus(db, opts);

    expect(status.latestVersion).toBe("0.3.0");
    expect(status.available).toBe(false);
  });

  it("ignores pre-releases, whether flagged or only tagged as one, and drafts", async () => {
    const opts = options(
      respondWith(200, [
        release("v0.5.0", { prerelease: true }),
        release("v0.4.1-beta.1"),
        release("v0.4.0", { draft: true }),
        release("v0.3.0"),
      ]),
    );

    await checkForUpdates(db, opts);
    const status = readUpdateStatus(db, opts);

    expect(status.latestVersion).toBe("0.3.0");
    expect(status.available).toBe(false);
  });

  it("treats an empty release list as nothing to report", async () => {
    const opts = options(respondWith(200, []));

    expect(await checkForUpdates(db, opts)).toBe("checked");
    expect(readUpdateStatus(db, opts)).toMatchObject({ check: "on", latestVersion: null, available: false });
  });

  it("treats a 404 (no public releases yet) the same as an empty list", async () => {
    const opts = options(respondWith(404, { message: "Not Found" }));

    expect(await checkForUpdates(db, opts)).toBe("checked");
    expect(readUpdateStatus(db, opts)).toMatchObject({
      check: "on",
      latestVersion: null,
      available: false,
      checkedAt: clock.toISOString(),
    });
  });

  it("checks at most once a day, counting failed attempts too", async () => {
    const failing: FetchLike = async (url, init) => {
      calls.push({ url, init });
      throw new TypeError("fetch failed");
    };

    expect(await checkForUpdates(db, options(failing))).toBe("failed");
    clock = new Date(clock.getTime() + CHECK_INTERVAL_MS - 1);
    expect(await checkForUpdates(db, options(respondWith(200, [release("v0.4.0")])))).toBe("not-due");
    expect(calls).toHaveLength(1);

    clock = new Date(clock.getTime() + 1);
    expect(await checkForUpdates(db, options(respondWith(200, [release("v0.4.0")])))).toBe("checked");
    expect(calls).toHaveLength(2);
  });

  it("keeps the last good answer when a later check fails", async () => {
    await checkForUpdates(db, options(respondWith(200, [release("v0.4.0")])));
    clock = new Date(clock.getTime() + CHECK_INTERVAL_MS);

    expect(await checkForUpdates(db, options(respondWith(502)))).toBe("failed");
    expect(readUpdateStatus(db, options(respondWith(200)))).toMatchObject({ latestVersion: "0.4.0", available: true });
  });

  it("checks again when the stored attempt is in the future (clock moved back)", async () => {
    await checkForUpdates(db, options(respondWith(200)));
    clock = new Date(clock.getTime() - 60_000);

    expect(await checkForUpdates(db, options(respondWith(200)))).toBe("checked");
    expect(calls).toHaveLength(2);
  });

  it("sends no query string and only a version in the User-Agent", async () => {
    await checkForUpdates(db, options(respondWith(200)));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RELEASES_URL);
    expect(new URL(calls[0].url).search).toBe("");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("legato-server/0.3.0");
    expect(Object.keys(headers).sort()).toEqual(["Accept", "User-Agent"]);
  });

  describe("off", () => {
    it("never calls out with LEGATO_UPDATE_CHECK=off", async () => {
      const opts = options(respondWith(200, [release("v0.4.0")]), { env: { LEGATO_UPDATE_CHECK: "off" } });

      expect(await checkForUpdates(db, opts)).toBe("off");
      expect(calls).toHaveLength(0);
      expect(readUpdateStatus(db, opts)).toEqual({
        check: "off",
        latestVersion: null,
        available: false,
        releaseUrl: null,
        checkedAt: null,
      });
    });

    it("never calls out when the setting is false, and hides an earlier answer", async () => {
      await checkForUpdates(db, options(respondWith(200, [release("v0.4.0")])));
      db.prepare("INSERT INTO settings (key, value) VALUES (?, 'false')").run(UPDATE_CHECK_SETTING);
      clock = new Date(clock.getTime() + CHECK_INTERVAL_MS);

      expect(await checkForUpdates(db, options(respondWith(200)))).toBe("off");
      expect(calls).toHaveLength(1);
      expect(readUpdateStatus(db, options(respondWith(200)))).toMatchObject({ check: "off", available: false });
    });

    it("never calls out from the desktop app's server", async () => {
      const opts = options(respondWith(200), { env: { LEGATO_INSTALL_CHANNEL: "desktop" } });

      expect(await checkForUpdates(db, opts)).toBe("off");
      expect(calls).toHaveLength(0);
    });

    it("never calls out from a source run", async () => {
      const opts = options(respondWith(200), { version: "0.0.0-dev" });

      expect(await checkForUpdates(db, opts)).toBe("off");
      expect(calls).toHaveLength(0);
    });
  });
});

describe("isNewerVersion", () => {
  it("compares numerically, not as strings", () => {
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("v1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.2.9", "0.3.0")).toBe(false);
  });

  it("ranks a stable release above a pre-release of the same version", () => {
    expect(isNewerVersion("0.4.0", "0.4.0-rc.1")).toBe(true);
    expect(isNewerVersion("0.4.0-rc.1", "0.4.0")).toBe(false);
  });

  it("is false for anything that isn't a version", () => {
    expect(isNewerVersion("nightly", "0.3.0")).toBe(false);
  });
});

describe("pickLatestStable", () => {
  it("picks the highest version, not the first listed", () => {
    expect(pickLatestStable([release("v0.3.0"), release("v0.10.0"), release("v0.9.0")])?.version).toBe("0.10.0");
  });

  it("ignores a body that isn't a release list", () => {
    expect(pickLatestStable({ message: "API rate limit exceeded" })).toBeNull();
    expect(pickLatestStable([null, 4, { tag_name: 7 }])).toBeNull();
  });
});

describe("resolveInstallChannel", () => {
  it("accepts each channel and falls back to unknown", () => {
    expect(resolveInstallChannel({ LEGATO_INSTALL_CHANNEL: "docker" })).toBe("docker");
    expect(resolveInstallChannel({ LEGATO_INSTALL_CHANNEL: " Brew " })).toBe("brew");
    expect(resolveInstallChannel({ LEGATO_INSTALL_CHANNEL: "snap" })).toBe("unknown");
    expect(resolveInstallChannel({})).toBe("unknown");
  });
});
