// VERSION/GIT_SHA are baked in at compile time via `bun build --define`
// (see scripts/compile.ts) — issue #102's whole point is a binary that
// runs with nothing beside it, so there's no package.json or .git
// directory left at runtime to read either of these from.
//
// `typeof __LEGATO_VERSION__ !== "undefined"` is the standard JS
// global-detection idiom (same shape as `typeof window !== "undefined"`):
// referencing an undeclared global directly throws a ReferenceError, but
// `typeof` on one doesn't. That matters here because `--define` is a
// `bun build` bundling step — `bun --watch src/index.ts` (dev), plain
// `bun src/index.ts` (`npm run start`, unchanged per #102's scope) and
// `bun test` never go through `bun build` at all, so these globals are
// simply never defined outside a compiled binary, and this falls through
// to the placeholders below instead of crashing.
declare const __LEGATO_VERSION__: string | undefined;
declare const __LEGATO_GIT_SHA__: string | undefined;

// Exported so the update check (update/check.ts) can tell a source run
// apart from a release without re-typing the placeholder.
export const DEV_VERSION = "0.0.0-dev";

export const VERSION = typeof __LEGATO_VERSION__ !== "undefined" ? __LEGATO_VERSION__ : DEV_VERSION;
export const GIT_SHA = typeof __LEGATO_GIT_SHA__ !== "undefined" ? __LEGATO_GIT_SHA__ : "unknown";
