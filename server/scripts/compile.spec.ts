import { describe, expect, it } from "bun:test";
import { openDb } from "../src/db.js";
import { checkForUpdates, readUpdateStatus, type FetchLike } from "../src/update/check.js";
import { resolveVersion } from "./compile.js";

// Issue #404: the Pi ran a binary deploy-server.sh compiled from main, which
// said it was package.json's 0.0.0, so every release looked newer and its
// clients were told to update for good.
describe("resolveVersion", () => {
  it("stamps the release's version when the release workflow names one", () => {
    expect(resolveVersion({ LEGATO_RELEASE_VERSION: "0.1.0" })).toBe("0.1.0");
  });

  it("turns the update check off for a binary compiled from a checkout", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify([{ tag_name: "v0.1.0", draft: false, prerelease: false }]), { status: 200 });
    };
    const db = openDb(":memory:");

    // deploy-server.sh unsets the variable; a local Docker build passes it empty.
    for (const env of [{}, { LEGATO_RELEASE_VERSION: "" }]) {
      const opts = { fetch: fetchFn, env: {}, version: resolveVersion(env) };
      expect(await checkForUpdates(db, opts)).toBe("off");
      expect(readUpdateStatus(db, opts)).toMatchObject({ check: "off", available: false });
    }
    expect(calls).toHaveLength(0);
  });
});
