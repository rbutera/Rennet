import type { Patchset, ReviewHypothesis, RspCapabilitySnapshot } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildOfferedManifest } from "./angle-generation";
import { decompose } from "./decomposition";
import { runFindingAngle } from "./finding-generation";
import { createInvocationBudget } from "./invocation-budget";
import { runNoiseAngle } from "./noise-generation";

const PATCHSET: Patchset = {
  id: "ps_inject",
  createdAt: "2026-01-01T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: null,
      deletions: null,
      binary: false,
      patch:
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n+export const a = 1;\n",
    },
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const MANIFEST = buildOfferedManifest(decompose(PATCHSET));
const CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
};
const SEED = {
  harness: "claude-code",
  harnessVersion: "2.1.220",
  adapterVersion: "0.1.0",
  model: "m",
  modelReportedBy: "harness" as const,
  capability: CAPABILITY,
};

const HYPOTHESIS: ReviewHypothesis = {
  domain: "the review store keying domain",
  scope: { inScope: ["store keying"], outOfScope: ["knowledge layer"] },
  designExpectation: "resolve the key from realpath of git-common-dir",
  risks: [
    {
      riskId: "R1",
      statement: "the key is computed per branch instead of per repository",
      severity: "high",
      disconfirmer: "verify the key uses git-common-dir and not the branch name",
    },
  ],
  repoContextPresent: true,
};

describe("hypothesis injection — the disconfirmation layer reaches every lens runner (#178)", () => {
  it("injects a labelled hypothesis layer into the finding runner's prompt, without truncating the base", async () => {
    let prompt = "";
    await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      hypothesis: HYPOTHESIS,
      provenance: SEED,
      runTurn: (p) => {
        prompt = p;
        return Promise.resolve({ status: "emitted", body: { findings: [] } });
      },
      budget: createInvocationBudget(5),
    });
    // The labelled layer is present, carrying the risk + disconfirmer.
    expect(prompt).toContain("<<<rennet:layer hypothesis>>>");
    expect(prompt).toContain("Committed review hypothesis");
    expect(prompt).toContain("verify the key uses git-common-dir");
    // The base instruction is never truncated to fit it.
    expect(prompt).toContain("<<<rennet:layer base>>>");
    expect(prompt).toContain("# Rennet base instruction: finding@1");
    // Positioned AFTER the base and BEFORE the payload (the fixed assembly order).
    const baseIdx = prompt.indexOf("<<<rennet:layer base>>>");
    const hypIdx = prompt.indexOf("<<<rennet:layer hypothesis>>>");
    const payloadIdx = prompt.indexOf("<<<rennet:layer payload>>>");
    expect(baseIdx).toBeLessThan(hypIdx);
    expect(hypIdx).toBeLessThan(payloadIdx);
  });

  it("leaves the runner's prompt unchanged when no hypothesis is supplied", async () => {
    let prompt = "";
    await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      provenance: SEED,
      runTurn: (p) => {
        prompt = p;
        return Promise.resolve({ status: "emitted", body: { findings: [] } });
      },
      budget: createInvocationBudget(5),
    });
    expect(prompt).not.toContain("<<<rennet:layer hypothesis>>>");
  });

  it("also reaches the noise runner (every lens disconfirms against the same prior)", async () => {
    let prompt = "";
    await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      hypothesis: HYPOTHESIS,
      noiseJobModel: "Claude",
      provenance: SEED,
      runTurn: (p) => {
        prompt = p;
        return Promise.resolve({ status: "emitted", body: { groups: [] } });
      },
      budget: createInvocationBudget(5),
    });
    expect(prompt).toContain("<<<rennet:layer hypothesis>>>");
    expect(prompt).toContain("verify the key uses git-common-dir");
  });
});
