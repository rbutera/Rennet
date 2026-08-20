import type { CiFailure, OfferedManifest } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { ciFindingsFor, classifyCiFailures } from "./ci-classification";
import type { ForgeCheckRun } from "./forge-port";

function check(name: string, summary: string, id = `check:${name}`): ForgeCheckRun {
  return { id, name, outcome: "failing", summary };
}

describe("classifyCiFailures", () => {
  it.each([
    "The runner has lost communication with the server",
    "Timed out waiting for a hosted runner to come online",
    "Hosted runner: no space left on device",
    "Package registry returned HTTP 429 rate limit exceeded",
    "Hosted runner request failed: ECONNRESET",
    "GitHub Actions artifact service: artifact upload failed: service unavailable",
    "Cancelled because a higher-priority run owns the concurrency group",
  ])("classifies machinery failures as environmental: %s", (summary) => {
    expect(
      classifyCiFailures([check("build", summary)], ["packages/core/src/pipeline.ts"]),
    ).toEqual([expect.objectContaining({ verdict: "environmental", implicatedPaths: [] })]);
  });

  it("does not wave away a test-suite timeout as infrastructure", () => {
    expect(
      classifyCiFailures(
        [check("integration", "Test suite timed out after 30 seconds")],
        ["packages/core/src/pipeline.ts"],
      )[0]?.verdict,
    ).toBe("unclassified");
  });

  it.each([
    [
      "test",
      "AssertionError: expected backoff after rate limit exceeded in packages/core/src/rate-limit.ts",
      "packages/core/src/rate-limit.ts",
    ],
    [
      "rate limit handling › retries",
      "AssertionError: expected retry backoff",
      "packages/core/src/rate-limit.ts",
    ],
    [
      "http client",
      "http-client.ts request failed with ETIMEDOUT",
      "packages/adapters/src/http-client.ts",
    ],
  ])(
    "lets changed-code overlap win over application-shaped infra words: %s",
    (name, summary, changedPath) => {
      expect(classifyCiFailures([check(name, summary)], [changedPath])[0]).toMatchObject({
        verdict: "change-caused",
        implicatedPaths: [changedPath],
      });
    },
  );

  it.each([
    "AssertionError: expected backoff after rate limit exceeded",
    "application request failed with ETIMEDOUT",
    "getaddrinfo ENOTFOUND api.customer.test",
    "Artifact upload failed in the application",
  ])("keeps bare application failure language visible as unclassified: %s", (summary) => {
    expect(
      classifyCiFailures([check("application test", summary)], ["src/other.ts"])[0]?.verdict,
    ).toBe("unclassified");
  });

  it.each([
    ["test", "Assertion failed in packages/core/src/pipeline.ts"],
    ["test", "pipeline.ts fails the null case"],
    ["core:test", "one test failed"],
  ])("attributes real path, stem, and project-token overlap", (name, summary) => {
    const failure = classifyCiFailures(
      [check(name, summary)],
      ["packages/core/src/pipeline.ts"],
    )[0];
    expect(failure).toMatchObject({
      verdict: "change-caused",
      implicatedPaths: ["packages/core/src/pipeline.ts"],
      classifiedBy: "deterministic",
    });
  });

  it("keeps an uncertain failure visible as unclassified", () => {
    const failure = classifyCiFailures(
      [check("acceptance", "Snapshot mismatch in an unnamed scenario")],
      ["packages/core/src/pipeline.ts"],
    )[0];
    expect(failure).toMatchObject({ verdict: "unclassified", implicatedPaths: [] });
  });

  it("classifies only failing checks and is stable under check reordering", () => {
    const checks: ForgeCheckRun[] = [
      check("core:test", "pipeline failed"),
      { id: "check:lint", name: "lint", outcome: "passing", summary: "" },
      check("acceptance", "Snapshot mismatch in an unnamed scenario"),
    ];
    const forward = classifyCiFailures(checks, ["packages/core/src/pipeline.ts"]);
    const reverse = classifyCiFailures([...checks].reverse(), ["packages/core/src/pipeline.ts"]);
    expect([...reverse].reverse()).toEqual(forward);
    expect(forward.map((failure) => failure.verdict)).toEqual(["change-caused", "unclassified"]);
  });
});

describe("ciFindingsFor", () => {
  const manifest: OfferedManifest = {
    occurrences: [
      { id: "h1", kind: "hunk", path: "packages/core/src/pipeline.ts" },
      { id: "h2", kind: "hunk", path: "packages/app-ui/src/app.tsx" },
    ],
  };
  const failure: CiFailure = {
    checkId: "check:core-test",
    checkName: "core:test",
    verdict: "change-caused",
    evidence: "pipeline.test.ts failed",
    implicatedPaths: ["packages/core/src/pipeline.ts"],
    classifiedBy: "deterministic",
  };

  it("folds a grounded change-caused failure into a reproduced high finding", () => {
    const first = ciFindingsFor([failure], manifest, "patch-1");
    const second = ciFindingsFor([failure], manifest, "patch-1");
    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        findingId: expect.any(String),
        anchor: "rennet:hunk/h1",
        summary: "CI check failed: core:test — pipeline.test.ts failed",
        severity: "high",
        agreement: { kind: "concur", agree: 1, total: 1 },
        verification: {
          verdict: "reproduced",
          evidence: "CI: core:test — pipeline.test.ts failed",
        },
      },
    ]);
  });

  it("emits no finding when the implicated path has no offered hunk", () => {
    expect(
      ciFindingsFor(
        [{ ...failure, implicatedPaths: ["packages/adapters/src/github-forge.ts"] }],
        manifest,
        "patch-1",
      ),
    ).toEqual([]);
  });

  it("uses stable check identity so same-named checks cannot collide", () => {
    const findings = ciFindingsFor(
      [failure, { ...failure, checkId: "check:other-workflow" }],
      manifest,
      "patch-1",
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]?.findingId).not.toBe(findings[1]?.findingId);
  });

  it("never turns environmental or unclassified failures into findings", () => {
    expect(
      ciFindingsFor(
        [
          { ...failure, verdict: "environmental" },
          { ...failure, verdict: "unclassified" },
        ],
        manifest,
        "patch-1",
      ),
    ).toEqual([]);
  });
});
