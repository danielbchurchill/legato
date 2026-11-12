import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_EDGE_RULE_MODULES, LOCAL_EDGE_RULES_HASH } from "./localEdgeRules.js";

const SRC = path.join(import.meta.dir, "..");

// The modules edges.ts reaches that don't decide which edges a file gets,
// and why, so they can change without every file being derived again.
const NOT_RULES: Record<string, string> = {
  "enrich/members.ts": "markBoundMayHaveShrunk only flags the next start's membership prune",
  "enrich/queue.ts": "enrichment jobs, reached through members.ts and aggregate.ts",
  "entities/aggregate.ts": "refreshTrackKeys keeps the Tracks table's keys for a file derived on its own; no edges",
  "entities/bridges.ts": "reached through aggregate.ts",
  "entities/mode.ts": "reached through aggregate.ts",
  "writeInChunks.ts": "reached through aggregate.ts; how writes are committed, not what",
};

// Every module edges.ts imports, and they import, for their code: `import
// type` is erased and decides nothing.
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const modulePath = stack.pop()!;
    if (seen.has(modulePath)) continue;
    seen.add(modulePath);
    const source = readFileSync(path.join(SRC, modulePath), "utf8");
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+["'](\.[^"']+)["']/gms),
      ...source.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gm),
    ].map((match) => match[1]!);
    for (const specifier of specifiers) {
      const resolved = path.relative(SRC, path.resolve(path.dirname(path.join(SRC, modulePath)), specifier));
      stack.push(resolved.replace(/\.js$/, ".ts"));
    }
  }
  return seen;
}

describe("the local edge rules (#323)", () => {
  it("hash every module edges.ts runs that decides an edge, and say why each of the others doesn't", () => {
    const closure = [...importClosure("match/edges.ts")].sort();
    const classified = [...LOCAL_EDGE_RULE_MODULES, ...Object.keys(NOT_RULES)].sort();
    expect(closure).toEqual(classified);
  });

  it("are the hash of those modules' source as it is on disk", () => {
    const hash = createHash("sha256");
    for (const modulePath of LOCAL_EDGE_RULE_MODULES) {
      hash.update(`${modulePath}\0${readFileSync(path.join(SRC, modulePath), "utf8")}\0`);
    }
    expect(LOCAL_EDGE_RULES_HASH).toBe(hash.digest("hex"));
  });
});
