import { sha256Hex } from "@rennet/protocol";
import type { CiFailure, FindingElement, OfferedManifest } from "@rennet/types";
import type { ForgeCheckRun } from "./forge-port";

export const CI_ENVIRONMENTAL_SIGNATURES_VERSION = 1;

const ENVIRONMENTAL_SIGNATURES: readonly RegExp[] = [
  /(?:runner|agent).*(?:lost communication|communication (?:was )?lost|disconnected|was lost)/i,
  /timed out waiting for (?:an? )?(?:hosted )?(?:runner|agent|machine|executor|job to start)/i,
  /no space left on device/i,
  /(?:secondary )?rate limit(?:ed| exceeded)?/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/i,
  /(?:getaddrinfo ENOTFOUND|temporary failure in name resolution|could not resolve host)/i,
  /artifact (?:upload|download).*(?:failed|error|service unavailable)/i,
  /(?:failed|error|service unavailable).*artifact (?:upload|download)/i,
  /cancelled.*(?:concurrency group|concurrent run)/i,
];

const PATH_STOPWORDS = new Set([
  "app",
  "apps",
  "config",
  "index",
  "lib",
  "libs",
  "package",
  "packages",
  "source",
  "src",
  "test",
  "tests",
  "spec",
  "specs",
  "typescript",
]);

function textTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2),
  );
}

function pathTokens(path: string): Set<string> {
  const tokens = textTokens(path);
  for (const token of [...tokens]) {
    if (PATH_STOPWORDS.has(token)) tokens.delete(token);
  }
  return tokens;
}

function implicatedPaths(check: ForgeCheckRun, changedPaths: readonly string[]): string[] {
  const text = `${check.name} ${check.summary}`.toLowerCase();
  const tokens = textTokens(text);
  return changedPaths.filter((path) => {
    const normalized = path.toLowerCase();
    if (text.includes(normalized)) return true;
    for (const token of pathTokens(normalized)) {
      if (tokens.has(token)) return true;
    }
    return false;
  });
}

function isEnvironmental(check: ForgeCheckRun): boolean {
  const text = `${check.name}\n${check.summary}`;
  return ENVIRONMENTAL_SIGNATURES.some((signature) => signature.test(text));
}

export function classifyCiFailures(
  checks: readonly ForgeCheckRun[],
  changedPaths: readonly string[],
): CiFailure[] {
  const failures: CiFailure[] = [];
  for (const check of checks) {
    if (check.outcome !== "failing") continue;
    const paths = isEnvironmental(check) ? [] : implicatedPaths(check, changedPaths);
    const verdict = isEnvironmental(check)
      ? "environmental"
      : paths.length > 0
        ? "change-caused"
        : "unclassified";
    failures.push({
      checkName: check.name,
      verdict,
      evidence: check.summary,
      implicatedPaths: paths,
      ...(check.detailsUrl === undefined ? {} : { detailsUrl: check.detailsUrl }),
      classifiedBy: "deterministic",
    });
  }
  return failures;
}

export function ciFindingsFor(
  failures: readonly CiFailure[],
  manifest: OfferedManifest,
  patchsetId: string,
): FindingElement[] {
  const findings: FindingElement[] = [];
  for (const failure of failures) {
    if (failure.verdict !== "change-caused") continue;
    const anchor = manifest.occurrences.find(
      (occurrence) =>
        occurrence.kind === "hunk" &&
        occurrence.path !== undefined &&
        failure.implicatedPaths.includes(occurrence.path),
    );
    if (!anchor) continue;
    const excerpt = failure.evidence.length > 0 ? failure.evidence : "no failure summary reported";
    findings.push({
      findingId: `ci-${sha256Hex(`${patchsetId}\0${failure.checkName}`).slice(0, 24)}`,
      anchor: `rennet:hunk/${anchor.id}`,
      summary: `CI check failed: ${failure.checkName} — ${excerpt}`,
      severity: "high",
      agreement: { kind: "concur", agree: 1, total: 1 },
      verification: {
        verdict: "reproduced",
        evidence: `CI: ${failure.checkName} — ${excerpt}`,
      },
    });
  }
  return findings;
}
