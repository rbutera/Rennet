import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// SPDX licence identifiers we ship without further review. `Unlicense` is a
// public-domain-equivalent dedication (transitive via fast-sha256, pulled by the
// Claude Agent SDK) and belongs in the allowlist next to MIT/ISC — unlike the
// "Unknown" bucket below, it is a real, readable, known-good licence.
const allowed = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

// Deliberate exception, Rai's decision 2026-08-06 (Master Plan R2). The Claude
// Agent SDK is proprietary (Anthropic Commercial Terms, "SEE LICENSE IN
// README.md") and pnpm reports it — plus its per-platform binary packages — in
// the "Unknown" bucket. We ship it knowingly. Allow it BY NAME.
//
// ⛔ We do NOT add "Unknown" to `allowed`. "Unknown" is the bucket pnpm assigns
// to EVERY dependency whose licence it cannot read, so allowlisting the bucket
// would silently disable this gate for every future unreadable-licence package —
// the exact class it exists to catch. Instead the Unknown bucket's MEMBERS are
// filtered against this named allowlist, and any Unknown-bucket package not named
// here still blocks the build.
const allowedUnknownPackages = new Set([
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  // Linux CI (ubuntu-latest, x64) surfaces the linux-x64 per-platform binary,
  // just as darwin surfaces darwin-arm64. Same knowingly-shipped SDK, same
  // stripped-at-packaging status; allowlisted BY NAME (the positive control below
  // still fires on any un-named Unknown-bucket package).
  "@anthropic-ai/claude-agent-sdk-linux-x64",
  // The remaining per-platform binaries are stripped at packaging and are not
  // installed on these platforms; add them here if a build ever surfaces one.
]);

/**
 * Pure blocking logic. Returns the list of `{ license, name }` records that must
 * fail the build. Exported so the gate's fail-ability can be proven directly.
 *
 * - An allowed licence never blocks.
 * - The "Unknown" bucket blocks per-MEMBER: only packages not in
 *   `allowedUnknownPackages` block. This keeps the gate live for every future
 *   unreadable-licence package while permitting the deliberately-adopted ones.
 * - Any other non-allowed licence blocks every package under it.
 */
export function computeBlocked(report, policy) {
  const blocked = [];
  for (const [license, packages] of Object.entries(report)) {
    if (policy.allowed.has(license)) continue;
    if (license === "Unknown") {
      for (const pkg of packages) {
        if (!policy.allowedUnknownPackages.has(pkg.name)) {
          blocked.push({ license, name: pkg.name });
        }
      }
      continue;
    }
    for (const pkg of packages) blocked.push({ license, name: pkg.name });
  }
  return blocked;
}

export const POLICY = { allowed, allowedUnknownPackages };

/**
 * Positive control: prove the gate can still fail. A fabricated package placed
 * in the "Unknown" bucket MUST be reported blocked; if the named-exception
 * filter ever regresses into allowlisting the whole bucket, this catches it.
 * The needle is generated fresh each run so it can never leak into the corpus
 * the gate reads. This runs on every invocation, on the same path as the real
 * check, so it cannot be skipped.
 */
export function assertGateCanFail(policy) {
  const needle = `__rennet_license_gate_control__${randomUUID()}`;
  const controlReport = { Unknown: [{ name: needle }] };
  const controlBlocked = computeBlocked(controlReport, policy);
  if (!controlBlocked.some((entry) => entry.name === needle)) {
    throw new Error(
      "Licence gate positive control FAILED: a fabricated Unknown-bucket package " +
        "was NOT blocked. The gate can no longer detect an unvetted unreadable-licence " +
        "dependency and must not be trusted. Refusing to certify.",
    );
  }
}

function main() {
  assertGateCanFail(POLICY);

  const report = JSON.parse(
    execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], { encoding: "utf8" }),
  );
  const blocked = computeBlocked(report, POLICY);

  if (blocked.length > 0) {
    const detail = blocked.map((entry) => `${entry.name} (${entry.license})`).join(", ");
    throw new Error(`Blocked shipped dependency licences: ${detail}`);
  }

  const packageCount = Object.values(report).reduce(
    (total, packages) => total + packages.length,
    0,
  );
  console.log(
    `Checked ${packageCount} shipped dependency records across ${Object.keys(report).length} licence buckets ` +
      `(positive control passed; ${allowedUnknownPackages.size} named Unknown-bucket exceptions).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
