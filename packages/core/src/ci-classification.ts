import type { CiFailure, FindingElement, OfferedManifest } from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import type { ForgeCheckRun } from "./forge-port";

export const CI_ENVIRONMENTAL_SIGNATURES_VERSION = 2;

const ENVIRONMENTAL_SIGNATURES: readonly RegExp[] = [
  /(?:the (?:hosted |self-hosted )?runner has lost communication with (?:the )?(?:server|github actions)|(?:hosted |self-hosted )?runner (?:disconnected|was lost))/i,
  /timed out waiting for (?:an? )?(?:hosted )?(?:runner|agent|machine|executor|job to start)/i,
  /(?:runner|build agent|build machine).{0,80}no space left on device/i,
  /no space left on device.{0,80}(?:runner|build agent|build machine)/i,
  /(?:github api|github actions?|package registry|container registry|artifact (?:service|storage)|checkout action|setup action).{0,80}(?:(?:http )?429|(?:secondary )?rate limit(?:ed| exceeded)?)/i,
  /(?:(?:http )?429|(?:secondary )?rate limit(?:ed| exceeded)?).{0,80}(?:github api|github actions?|package registry|container registry|artifact (?:service|storage)|checkout action|setup action)/i,
  /(?:hosted runner|build agent|build machine|package registry|container registry|artifact (?:service|storage)|checkout action|setup action|ci setup).{0,100}\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b.{0,100}(?:hosted runner|build agent|build machine|package registry|container registry|artifact (?:service|storage)|checkout action|setup action|ci setup)/i,
  /(?:hosted runner|build agent|build machine|package registry|container registry|artifact (?:service|storage)|checkout action|setup action|ci setup).{0,100}(?:getaddrinfo ENOTFOUND|temporary failure in name resolution|could not resolve host)/i,
  /(?:getaddrinfo ENOTFOUND|temporary failure in name resolution|could not resolve host).{0,100}(?:hosted runner|build agent|build machine|package registry|container registry|artifact (?:service|storage)|checkout action|setup action|ci setup)/i,
  /(?:github actions?|artifact (?:service|storage)|upload-artifact action|download-artifact action).{0,80}artifact (?:upload|download).{0,80}(?:failed|error|service unavailable)/i,
  /(?:failed|error|service unavailable).{0,80}artifact (?:upload|download).{0,80}(?:github actions?|artifact (?:service|storage)|upload-artifact action|download-artifact action)/i,
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
  const text = `${check.name} ${check.summary}`;
  return ENVIRONMENTAL_SIGNATURES.some((signature) => signature.test(text));
}

export function classifyCiFailures(
  checks: readonly ForgeCheckRun[],
  changedPaths: readonly string[],
): CiFailure[] {
  const failures: CiFailure[] = [];
  for (const check of checks) {
    if (check.outcome !== "failing") continue;
    const paths = implicatedPaths(check, changedPaths);
    const verdict =
      paths.length > 0
        ? "change-caused"
        : isEnvironmental(check)
          ? "environmental"
          : "unclassified";
    failures.push({
      checkId: check.id,
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

export function ciFindingIdFor(failure: CiFailure, patchsetId: string): string {
  return `ci-${sha256Hex(`${patchsetId}\0${failure.checkId}\0${failure.checkName}`).slice(0, 24)}`;
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
      findingId: ciFindingIdFor(failure, patchsetId),
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
