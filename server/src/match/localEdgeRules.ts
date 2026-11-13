import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// Issue #323: which rules local edges are derived by. recompute() derives
// only the files whose inputs changed (match/localEdgesQueue.ts), so when
// the rules themselves change, which is what match/backfill-edges.ts was
// written for, nothing about any file says so. What does is this hash of the
// source of every module that decides what deriveLocalEdges makes from the
// same rows. recompute() stores it once every file has been derived by
// those rules, and derives every file again whenever the build's hash isn't
// the stored one. No version to remember to bump: any edit to one of these
// files, a comment included, re-derives every file once, which costs one
// recompute what every recompute cost before #323.
//
// localEdgeRules.spec.ts checks this list against the modules edges.ts
// imports, so a module that starts deciding edges can't be left out.
export const LOCAL_EDGE_RULE_MODULES = [
  "match/edges.ts",
  "match/albumIdentity.ts",
  "match/artistLookup.ts",
  "match/evidence.ts",
  "match/people.ts",
  "match/releases.ts",
  "scan/artist-credit.ts",
] as const;

/** The hash of the rule modules' source, each read through `read` by its
 *  path under server/src. */
export function hashLocalEdgeRules(read: (modulePath: string) => string): string {
  const hash = createHash("sha256");
  for (const modulePath of LOCAL_EDGE_RULE_MODULES) hash.update(`${modulePath}\0${read(modulePath)}\0`);
  return hash.digest("hex");
}

/** The rule modules read from the source tree this module is in. */
export function hashLocalEdgeRulesFromSource(): string {
  const srcDir = path.join(import.meta.dir, "..");
  return hashLocalEdgeRules((modulePath) => readFileSync(path.join(srcDir, modulePath), "utf8"));
}

// A compiled binary has no source tree, so scripts/compile.ts works the hash
// out while it builds and bakes it in with `--define`, as version.ts's
// values are, into the server and its recompute Worker alike. Not a text
// import of each module: Bun's bundler can't import a file as text and as
// code in one build. Everywhere else (`bun src/index.ts`, the Worker it
// starts, `bun test`) the source is right here to read.
declare const __LEGATO_LOCAL_EDGE_RULES__: string | undefined;

export const LOCAL_EDGE_RULES_HASH =
  typeof __LEGATO_LOCAL_EDGE_RULES__ !== "undefined" ? __LEGATO_LOCAL_EDGE_RULES__ : hashLocalEdgeRulesFromSource();
