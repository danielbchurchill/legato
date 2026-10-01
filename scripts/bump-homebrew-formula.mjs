#!/usr/bin/env node
// Rewrites a Homebrew formula (packaging/homebrew/legato.rb, or the tap's
// Formula/legato.rb once it moves there) to a new release: every
// release-archive url gets the new version, and the sha256 on the line
// right after it gets that archive's checksum from the SHA256SUMS that
// scripts/package-release.mjs writes and release.yml publishes. Issue #109;
// release.yml's `homebrew` job is the caller.
//
// Run: node scripts/bump-homebrew-formula.mjs <formula.rb> <version> <SHA256SUMS>
//
// The formula has no `version` line (brew audit --strict rejects one that
// repeats the url's), so the version lives only in the urls, and the
// target name is what tells one archive's sha256 from another's. This fails
// rather than writing a half-bumped formula: a url with no sha256 line
// after it, a target missing from SHA256SUMS, or no url at all. A formula
// that installs the new version with an old checksum fails for every user,
// so a red release job costs less.

import { readFile, writeFile } from "node:fs/promises";

// The four non-Windows targets of package-release.mjs's RELEASE_TARGETS.
// Listed rather than matched loosely so a pre-release version with its own
// hyphens (1.0.0-rc.1) can't be mistaken for part of the target name.
const FORMULA_TARGETS = ["darwin-arm64", "darwin-x64-baseline", "linux-arm64", "linux-x64-baseline"];
const URL_LINE = new RegExp(
  `^(\\s*url\\s+"https://github\\.com/[^"]+/releases/download/v)[^/"]+(/legato-server-)[^"]+-(${FORMULA_TARGETS.join("|")})\\.tar\\.gz"`,
);
const SHA_LINE = /^(\s*sha256\s+)"[0-9a-f]{64}"/;

function parseChecksums(text) {
  const byArchive = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
    if (match) byArchive.set(match[2], match[1]);
  }
  return byArchive;
}

function bumpFormula(formula, version, checksums) {
  const lines = formula.split("\n");
  const bumped = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(URL_LINE);
    if (!match) continue;
    const target = match[3];
    const archive = `legato-server-${version}-${target}.tar.gz`;
    const sha = checksums.get(archive);
    if (!sha) throw new Error(`SHA256SUMS has no entry for ${archive}`);
    if (!SHA_LINE.test(lines[i + 1] ?? "")) {
      throw new Error(`url for ${target} (line ${i + 1}) isn't followed by a sha256 "<64 hex>" line`);
    }
    lines[i] = lines[i].replace(URL_LINE, `$1${version}$2${version}-${target}.tar.gz"`);
    lines[i + 1] = lines[i + 1].replace(SHA_LINE, `$1"${sha}"`);
    bumped.push(target);
  }
  if (bumped.length === 0) throw new Error("formula has no legato-server-<version>-<target>.tar.gz release url to bump");
  return { formula: lines.join("\n"), bumped };
}

async function main() {
  const [formulaPath, version, sumsPath] = process.argv.slice(2);
  if (!formulaPath || !version || !sumsPath) {
    console.error("usage: node scripts/bump-homebrew-formula.mjs <formula.rb> <version> <SHA256SUMS>");
    process.exit(1);
  }
  const checksums = parseChecksums(await readFile(sumsPath, "utf8"));
  const { formula, bumped } = bumpFormula(await readFile(formulaPath, "utf8"), version, checksums);
  await writeFile(formulaPath, formula);
  console.log(`${formulaPath} -> ${version} (${bumped.join(", ")})`);
}

main().catch((err) => {
  console.error(`bump-homebrew-formula failed: ${err.message}`);
  process.exit(1);
});
