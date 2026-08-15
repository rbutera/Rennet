import type { ForgeCiStatus } from "@rennet/core";
import type { FindingElement, FlaggedReview, Patchset, ReviewPostTarget } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { attachCiSignal } from "./ci-signal";

const target: ReviewPostTarget = {
  repo: { forge: "github", owner: "rbutera", name: "rennet" },
  number: 182,
  forgeRef: "PR_182",
  headOid: "reviewed-head",
};
const patchset: Patchset = {
  id: "patch-1",
  createdAt: "2026-08-15T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "main",
    baseOid: "base",
    headOid: "reviewed-head",
  },
  files: [
    {
      path: "packages/core/src/pipeline.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      patch: "+change",
    },
  ],
  rawDiff: "+change",
  byteLength: 7,
  truncated: false,
};
const manifest = {
  occurrences: [{ id: "h1", kind: "hunk" as const, path: "packages/core/src/pipeline.ts" }],
};
const modelFinding: FindingElement = {
  findingId: "model-1",
  anchor: "rennet:hunk/h1",
  summary: "model finding",
  severity: "medium",
  agreement: { kind: "concur", agree: 1, total: 1 },
  verification: { verdict: "reproduced", evidence: "model evidence" },
};
const review: FlaggedReview = { status: "ok", findings: [modelFinding] };

function status(checks: ForgeCiStatus["checks"], partial = false): ForgeCiStatus {
  return {
    checks,
    sso: partial
      ? { kind: "partial-results", organizations: ["ORG"], authorizationUrl: null }
      : { kind: "none" },
  };
}

describe("attachCiSignal", () => {
  it("keeps the pre-change shape when there is no postTarget", async () => {
    const fetchCiStatus = vi.fn();
    const result = await attachCiSignal({ review, patchset, manifest, fetchCiStatus });
    expect(result).toBe(review);
    expect(result).not.toHaveProperty("ciSignal");
    expect(fetchCiStatus).not.toHaveBeenCalled();
  });

  it("fetches the pinned head and distinguishes passing from no checks", async () => {
    const fetchPassing = vi.fn(async () =>
      status([{ name: "test", outcome: "passing", summary: "" }]),
    );
    const passing = await attachCiSignal({
      review,
      postTarget: target,
      patchset,
      manifest,
      fetchCiStatus: fetchPassing,
    });
    const noChecks = await attachCiSignal({
      review,
      postTarget: target,
      patchset,
      manifest,
      fetchCiStatus: async () => status([]),
    });
    expect(fetchPassing).toHaveBeenCalledWith(
      { repo: target.repo, number: target.number },
      "reviewed-head",
    );
    expect(passing.ciSignal).toEqual({
      status: "checked",
      overall: "passing",
      failures: [],
      headOid: "reviewed-head",
      incomplete: false,
    });
    expect(noChecks.ciSignal).toEqual({ status: "no-checks", headOid: "reviewed-head" });
  });

  it("appends grounded CI findings after untouched model findings", async () => {
    const result = await attachCiSignal({
      review,
      postTarget: target,
      patchset,
      manifest,
      fetchCiStatus: async () =>
        status([
          {
            name: "core:test",
            outcome: "failing",
            summary: "pipeline.ts failed",
          },
        ]),
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.findings[0]).toEqual(modelFinding);
    expect(result.findings[1]).toMatchObject({
      anchor: "rennet:hunk/h1",
      severity: "high",
      verification: { verdict: "reproduced", evidence: "CI: core:test — pipeline.ts failed" },
    });
  });

  it("turns a throwing fetch into unavailable and leaves model findings untouched", async () => {
    const result = await attachCiSignal({
      review,
      postTarget: target,
      patchset,
      manifest,
      fetchCiStatus: async () => {
        throw new Error("network down");
      },
    });
    expect(result).toEqual({
      status: "ok",
      findings: [modelFinding],
      ciSignal: { status: "unavailable", reason: "network down" },
    });
  });

  it("attaches red CI to a failed model review and marks partial results incomplete", async () => {
    const failed: FlaggedReview = { status: "failed", reason: "both finding seats failed" };
    const result = await attachCiSignal({
      review: failed,
      postTarget: target,
      patchset,
      manifest,
      fetchCiStatus: async () =>
        status([{ name: "acceptance", outcome: "failing", summary: "unknown failure" }], true),
    });
    expect(result).toMatchObject({
      ...failed,
      ciSignal: { status: "checked", overall: "failing", incomplete: true },
    });
  });
});
