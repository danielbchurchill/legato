#!/usr/bin/env node
// Fails the build when the built CSS gives `.glass` only the prefixed
// backdrop-filter. Chromium ignores -webkit-backdrop-filter, so without the
// standard declaration every glass surface (panels, rail, capsule, player,
// cards, popovers) draws unblurred in Chrome, Edge and WebView2, while WebKit
// still looks right and hides the problem (#296).
//
// Lightning CSS, which Vite uses to minify CSS, keeps only the last of the
// pair, so this is a check on the output rather than on src/index.css: it
// also catches a minifier upgrade that changes the rule.
//
// Run after `vite build` (`npm run build` does).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const assets = path.resolve(import.meta.dirname, "..", "dist", "assets");
const css = readdirSync(assets)
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(path.join(assets, name), "utf8"))
  .join("\n");

const glass = css.match(/\.glass\{[^}]*\}/);
if (!glass) {
  console.error(`check-built-css: no .glass rule in ${assets}/*.css. Was the utility renamed?`);
  process.exit(1);
}
if (!/(^|[{;])backdrop-filter:/.test(glass[0].slice(glass[0].indexOf("{")))) {
  console.error(`check-built-css: .glass has no standard backdrop-filter, so Chromium won't blur it (#296):\n  ${glass[0]}`);
  process.exit(1);
}
console.log("check-built-css: .glass keeps the standard backdrop-filter");
