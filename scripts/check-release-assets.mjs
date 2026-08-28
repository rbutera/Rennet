#!/usr/bin/env node
// Asserts that a release TAG actually carries the installers it claims to ship.
//
// Two release runs broke in one day and both published nothing: a SIGPIPE in the
// `decide` step (ca443db0) and pnpm forwarding `--` into `release:check` (0d38fd73).
// Different mechanisms, one symptom — a tag that exists with no assets behind it,
// which is invisible to anyone whose install auto-updates from release assets.
// So this asserts the OUTCOME (assets present on the release) and never an
// intermediate exit code; every intermediate step in both failures was fine.
//
// Usage (assets JSON on stdin, so the check works even when `gh release view`
// found nothing at all):
//   gh release view "$TAG" --json assets | node scripts/check-release-assets.mjs <tag> macos windows
//
// Invoked as `node`, never `pnpm run` — pnpm forwarding its own `--` is exactly
// what broke v0.3.39.

const REQUIRED = {
  // Names as GitHub stores them: it replaces spaces with dots, so Squirrel's
  // "Rennet-<v> Setup.exe" is published as "Rennet-<v>.Setup.exe".
  macos: (v) => [`Rennet-${v}-arm64.dmg`, `Rennet-darwin-arm64-${v}.zip`],
  windows: (v) => [
    `Rennet-${v}.Setup.exe`,
    `Rennet-${v}-full.nupkg`,
    `Rennet-win32-x64-${v}.zip`,
    "RELEASES",
  ],
};

function fail(message) {
  console.error(`::error title=Release published no assets::${message}`);
  console.error(`release-assets: ${message}`);
  process.exit(1);
}

const [tag, ...platforms] = process.argv.slice(2).filter((argument) => argument !== "--");
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) fail(`expected a tag shaped vX.Y.Z, got ${tag}`);
// A guard with nothing to require would pass on an empty release. Refuse.
if (platforms.length === 0) fail("no platforms named — nothing would be checked");
for (const platform of platforms) {
  if (!REQUIRED[platform]) fail(`unknown platform ${platform}`);
}

const version = tag.slice(1);
const stdin = await new Promise((resolve, reject) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    text += chunk;
  });
  process.stdin.on("end", () => resolve(text));
  process.stdin.on("error", reject);
});

let present;
try {
  present = new Set(JSON.parse(stdin).assets.map((asset) => asset.name));
} catch (error) {
  fail(`cannot read assets JSON for ${tag}: ${error instanceof Error ? error.message : error}`);
}

const missing = platforms
  .map((platform) => [platform, REQUIRED[platform](version).filter((name) => !present.has(name))])
  .filter(([, names]) => names.length > 0);

if (missing.length > 0) {
  const platformNames = missing.map(([platform]) => platform).join(" and ");
  const detail = missing.map(([platform, names]) => `${platform}: ${names.join(", ")}`).join("; ");
  const found = [...present].join(", ") || "none";
  fail(
    `${tag} shipped nothing for ${platformNames} — missing ${detail}. Release assets: ${found}.`,
  );
}

console.log(
  `release-assets: ${tag} carries every ${platforms.join(" + ")} installer (${present.size} assets)`,
);
