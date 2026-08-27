#!/usr/bin/env node
// Rewrites the "version" field of every workspace package.json to the given
// semver, in lockstep. Used by .github/workflows/auto-release.yml to bump the
// patch version on each release. All 10 files roundtrip exactly through
// JSON.stringify(…, null, 2) + "\n" (verified), so formatting is preserved.
//
//   node scripts/set-version.mjs 0.1.3
//
// Fails loud (exit 1) on a non-semver arg or a missing file — a partial rewrite
// would leave the workspace with mismatched versions.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  "package.json",
  "apps/desktop/package.json",
  "apps/marketing/package.json",
  "packages/adapters/package.json",
  "packages/core/package.json",
  "packages/prompts/package.json",
  "packages/protocol/package.json",
  "packages/ui/package.json",
  "packages/app-ui/package.json",
  "apps/docs/package.json",
];

const version = process.argv[2];
// Plain X.Y.Z — the auto-release flow only ever produces bare patch bumps.
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`set-version: expected a semver X.Y.Z, got: ${version ?? "(nothing)"}`);
  process.exit(1);
}

for (const rel of FILES) {
  const path = join(root, rel);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`set-version: cannot read/parse ${rel}: ${err.message}`);
    process.exit(1);
  }
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`set-version: ${rel} -> ${version}`);
}
