import type { Database } from "../sqlite.js";
import { DEV_VERSION, VERSION } from "../version.js";
import { resolveInstallChannel } from "./installChannel.js";

// Issue #110: notify-only update check. The server asks GitHub's releases API whether a newer
// stable release exists, at most once a day, and /health passes the answer
// on so the client can show the install channel's own update command. It
// never downloads or installs anything.
//
// The request carries nothing about the library: no query string at all,
// no cookies, and a User-Agent that is only `legato-server/<version>`.
// GitHub sees an IP address and a version, the same as any release download.
//
// Off when any of these holds:
//   - LEGATO_UPDATE_CHECK=off in the environment (for installs managed by
//     config files, where nobody opens a settings screen)
//   - the `updateCheckEnabled` setting is "false" (PUT /api/v1/settings)
//   - the install channel is desktop: the Tauri updater (#129) owns that
//   - the server is a source run (version 0.0.0-dev), which updates with
//     git pull and has no release to compare against

export const RELEASES_URL = "https://api.github.com/repos/danielbchurchill/legato/releases";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// How often the timer wakes to see whether a check is due. Much shorter than
// CHECK_INTERVAL_MS so a laptop that slept through the 24-hour mark, or a
// setting switched back on, catches up within the hour instead of a day late.
const WAKE_INTERVAL_MS = 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 10_000;

export const UPDATE_CHECK_SETTING = "updateCheckEnabled";

// The last attempt and what it found, as one JSON value in the settings
// table. Persisted rather than held in memory so "at most once a day" holds
// across restarts: a Pi in a crash loop or a desktop app opened ten times a
// day still asks GitHub once.
const STATE_SETTING = "updateCheckState";

type CheckState = {
  /** ISO time of the last attempt, successful or not. */
  checkedAt: string;
  /** Newest stable release seen, or null when there were none. */
  latestVersion: string | null;
  releaseUrl: string | null;
};

// The `update` field of GET /api/v1/health (shape documented with
// HealthBody in routes/health.ts).
export type UpdateStatus = {
  check: "on" | "off";
  latestVersion: string | null;
  available: boolean;
  releaseUrl: string | null;
  checkedAt: string | null;
};

// Only the call shape this file uses, so a test's fake fetch doesn't need
// Bun's extras (fetch.preconnect) to type-check.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type UpdateCheckOptions = {
  env?: NodeJS.ProcessEnv;
  version?: string;
  now?: () => Date;
  fetch?: FetchLike;
};

export type CheckOutcome = "off" | "not-due" | "checked" | "failed";

type ParsedVersion = { core: [number, number, number]; prerelease: string | null };

// Enough semver for release tags: an optional leading "v", three numeric
// parts, an optional "-prerelease" suffix. Build metadata ("+...") is
// ignored, as semver says it should be for precedence.
export function parseVersion(raw: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

// True when `candidate` is a newer release than `running`. A stable release
// outranks a pre-release of the same core version, so someone running
// 0.4.0-rc.1 is told about 0.4.0.
export function isNewerVersion(candidate: string, running: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(running);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  return a.prerelease === null && b.prerelease !== null;
}

// The newest stable release in a GitHub releases list. Drafts and anything
// marked pre-release are skipped, and so is a tag carrying a pre-release
// suffix even when the release itself isn't flagged, so a notice never
// points someone at a beta. Anything not shaped like a release is ignored
// rather than trusted.
export function pickLatestStable(releases: unknown): { version: string; url: string | null } | null {
  if (!Array.isArray(releases)) return null;
  let latest: { version: string; url: string | null } | null = null;
  for (const release of releases) {
    if (typeof release !== "object" || release === null) continue;
    const { tag_name, draft, prerelease, html_url } = release as Record<string, unknown>;
    if (draft === true || prerelease === true || typeof tag_name !== "string") continue;
    const parsed = parseVersion(tag_name);
    if (!parsed || parsed.prerelease !== null) continue;
    const version = parsed.core.join(".");
    if (latest === null || isNewerVersion(version, latest.version)) {
      latest = { version, url: typeof html_url === "string" ? html_url : null };
    }
  }
  return latest;
}

function readSettings(db: Database): Map<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key IN (?, ?)")
    .all(UPDATE_CHECK_SETTING, STATE_SETTING) as { key: string; value: string }[];
  return new Map(rows.map((row) => [row.key, row.value]));
}

function readState(settings: Map<string, string>): CheckState | null {
  const raw = settings.get(STATE_SETTING);
  if (raw === undefined) return null;
  try {
    const state = JSON.parse(raw) as CheckState;
    return typeof state.checkedAt === "string" ? state : null;
  } catch {
    // A hand-edited or truncated value just means "never checked".
    return null;
  }
}

function writeState(db: Database, state: CheckState): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(STATE_SETTING, JSON.stringify(state));
}

function isEnabled(settings: Map<string, string>, env: NodeJS.ProcessEnv, version: string): boolean {
  if (env.LEGATO_UPDATE_CHECK?.trim().toLowerCase() === "off") return false;
  if (resolveInstallChannel(env) === "desktop") return false;
  if (version === DEV_VERSION) return false;
  return settings.get(UPDATE_CHECK_SETTING) !== "false";
}

// What /health reports. A settings read rather than an in-memory copy so
// switching the setting off hides the notice on the next heartbeat; it's
// two primary-key rows, nothing like the filesystem stat health.ts keeps
// off that endpoint. When the check is off, nothing cached from an earlier
// run is shown either: "off" should mean no update talk at all.
export function readUpdateStatus(db: Database, options: UpdateCheckOptions = {}): UpdateStatus {
  const env = options.env ?? process.env;
  const version = options.version ?? VERSION;
  const settings = readSettings(db);
  if (!isEnabled(settings, env, version)) {
    return { check: "off", latestVersion: null, available: false, releaseUrl: null, checkedAt: null };
  }
  const state = readState(settings);
  return {
    check: "on",
    latestVersion: state?.latestVersion ?? null,
    available: state?.latestVersion != null && isNewerVersion(state.latestVersion, version),
    releaseUrl: state?.releaseUrl ?? null,
    checkedAt: state?.checkedAt ?? null,
  };
}

// One check, if one is due. The attempt is recorded whether or not it
// works, so an unreachable GitHub (offline Pi, firewalled NAS) is asked
// once a day too, not on every wake. A failed attempt keeps whatever the
// last good one found.
export async function checkForUpdates(db: Database, options: UpdateCheckOptions = {}): Promise<CheckOutcome> {
  const env = options.env ?? process.env;
  const version = options.version ?? VERSION;
  const now = (options.now ?? (() => new Date()))();
  const fetchFn: FetchLike = options.fetch ?? fetch;

  const settings = readSettings(db);
  if (!isEnabled(settings, env, version)) return "off";

  const previous = readState(settings);
  const lastAttempt = previous ? Date.parse(previous.checkedAt) : Number.NaN;
  // A checkedAt in the future (clock moved back) counts as due, or the
  // check would stay silent until the clock caught up again.
  if (lastAttempt <= now.getTime() && now.getTime() - lastAttempt < CHECK_INTERVAL_MS) return "not-due";

  const failed: CheckState = {
    checkedAt: now.toISOString(),
    latestVersion: previous?.latestVersion ?? null,
    releaseUrl: previous?.releaseUrl ?? null,
  };

  try {
    const res = await fetchFn(RELEASES_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `legato-server/${version}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 404 is what GitHub answers for a repository it won't show an
    // anonymous caller (this one is private until launch), so it reads
    // the same as an empty list: no release to tell anyone about.
    if (res.status === 404) {
      writeState(db, { checkedAt: now.toISOString(), latestVersion: null, releaseUrl: null });
      return "checked";
    }
    if (!res.ok) {
      writeState(db, failed);
      return "failed";
    }
    const latest = pickLatestStable(await res.json());
    writeState(db, {
      checkedAt: now.toISOString(),
      latestVersion: latest?.version ?? null,
      releaseUrl: latest?.url ?? null,
    });
    return "checked";
  } catch {
    // Offline, DNS, timeout or a body that isn't JSON. None of them are
    // worth a warning in the log of a server whose job is music.
    writeState(db, failed);
    return "failed";
  }
}

// Called once from index.ts. Starts the first check without awaiting it, so
// a slow or unreachable GitHub never holds up startup, then wakes hourly to
// see whether the next one is due. The timer is unref'd: it shouldn't keep
// a process alive that has nothing else left to do.
export function startUpdateChecks(db: Database, log: (message: string) => void): void {
  const run = async () => {
    const outcome = await checkForUpdates(db);
    if (outcome !== "checked") return;
    const status = readUpdateStatus(db);
    if (status.available) log(`update: legato-server ${status.latestVersion} is available (running ${VERSION})`);
  };
  // checkForUpdates already swallows network errors; this catch is for the
  // database itself failing, which must not become an unhandled rejection.
  const runQuietly = () => void run().catch(() => {});
  runQuietly();
  setInterval(runQuietly, WAKE_INTERVAL_MS).unref();
}
