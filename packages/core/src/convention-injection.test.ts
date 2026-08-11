import type {
  ConventionCatalogue,
  Patchset,
  ReviewHypothesis,
  RspCapabilitySnapshot,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import { buildOfferedManifest } from "./angle-generation";
import { runDecisionAngle } from "./decision-generation";
import { decompose } from "./decomposition";
import { runFindingAngle } from "./finding-generation";
import { createInvocationBudget } from "./invocation-budget";
import { runNoiseAngle } from "./noise-generation";

// The per-project convention / anti-pattern checklist reaches every lens runner
// as a labelled layer (#180), mirroring the hypothesis-injection contract (#178).

const PATCHSET: Patchset = {
  id: "ps_conv",
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

// A tiny catalogue: one rule with an author id + anti-pattern, one minimal rule.
const CATALOGUE: ConventionCatalogue = {
  rules: [
    {
      id: "arch-boundary",
      convention: "file I/O lives only in the adapters package",
      rationale: "the core package must stay pure so a phone could import it",
      severity: "high",
      antiPattern: "importing node:fs from anywhere under packages/core",
    },
    {
      convention: "tests assert the contract, never the implementation",
      rationale: "an implementation-derived assertion can only confirm the code, not check it",
      severity: "medium",
    },
  ],
  source: "/repo/.rennet/conventions.json",
};

describe("convention injection — the checklist layer reaches every lens runner (#180)", () => {
  it("injects a labelled conventions layer into the finding runner, reporting the reason not a rule number", async () => {
    let prompt = "";
    await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      conventions: CATALOGUE,
      provenance: SEED,
      runTurn: (p) => {
        prompt = p;
        return Promise.resolve({ status: "emitted", body: { findings: [] } });
      },
      budget: createInvocationBudget(5),
    });
    // The labelled layer is present, carrying each convention and its rationale.
    expect(prompt).toContain("<<<rennet:layer conventions>>>");
    expect(prompt).toContain("Project conventions and anti-patterns");
    expect(prompt).toContain("file I/O lives only in the adapters package");
    expect(prompt).toContain("why: the core package must stay pure");
    expect(prompt).toContain("anti-pattern: importing node:fs");
    // The standing product rule: report the reason, NEVER a rule id or number.
    expect(prompt).toContain("NEVER a rule id or number");
    // The author-facing id is deliberately never rendered (no number to cite).
    expect(prompt).not.toContain("arch-boundary");
    // The base is never truncated to fit it.
    expect(prompt).toContain("<<<rennet:layer base>>>");
    expect(prompt).toContain("# Rennet base instruction: finding@1");
    // Positioned AFTER the base and BEFORE the payload (the fixed assembly order).
    const baseIdx = prompt.indexOf("<<<rennet:layer base>>>");
    const convIdx = prompt.indexOf("<<<rennet:layer conventions>>>");
    const payloadIdx = prompt.indexOf("<<<rennet:layer payload>>>");
    expect(baseIdx).toBeLessThan(convIdx);
    expect(convIdx).toBeLessThan(payloadIdx);
  });

  it("coexists with the hypothesis layer, conventions positioned right after it", async () => {
    let prompt = "";
    await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      hypothesis: HYPOTHESIS,
      conventions: CATALOGUE,
      provenance: SEED,
      runTurn: (p) => {
        prompt = p;
        return Promise.resolve({ status: "emitted", body: { findings: [] } });
      },
      budget: createInvocationBudget(5),
    });
    const hypIdx = prompt.indexOf("<<<rennet:layer hypothesis>>>");
    const convIdx = prompt.indexOf("<<<rennet:layer conventions>>>");
    expect(hypIdx).toBeGreaterThanOrEqual(0);
    expect(convIdx).toBeGreaterThan(hypIdx);
    // Both priors are present in one prompt.
    expect(prompt).toContain("verify the key uses git-common-dir");
    expect(prompt).toContain("tests assert the contract, never the implementation");
  });

  it("leaves the runner's prompt unchanged when no catalogue is supplied", async () => {
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
    expect(prompt).not.toContain("<<<rennet:layer conventions>>>");
  });

  it("treats an empty catalogue as no layer (byte-identical to no catalogue)", async () => {
    let prompt = "";
    await runFindingAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      conventions: { rules: [] },
      provenance: SEED,
      runTurn: (p) => {
        prompt = p;
        return Promise.resolve({ status: "emitted", body: { findings: [] } });
      },
      budget: createInvocationBudget(5),
    });
    expect(prompt).not.toContain("<<<rennet:layer conventions>>>");
  });

  it("also reaches the decision runner", async () => {
    let prompt = "";
    await runDecisionAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      conventions: CATALOGUE,
      provenance: SEED,
      runTurn: (p) => {
        prompt = p;
        return Promise.resolve({ status: "emitted", body: { decisions: [] } });
      },
      budget: createInvocationBudget(5),
    });
    expect(prompt).toContain("<<<rennet:layer conventions>>>");
    expect(prompt).toContain("file I/O lives only in the adapters package");
  });

  it("also reaches the noise runner (every lens checks the same conventions)", async () => {
    let prompt = "";
    await runNoiseAngle({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      conventions: CATALOGUE,
      noiseJobModel: "Claude",
      provenance: SEED,
      runTurn: (p) => {
        prompt = p;
        return Promise.resolve({ status: "emitted", body: { groups: [] } });
      },
      budget: createInvocationBudget(5),
    });
    expect(prompt).toContain("<<<rennet:layer conventions>>>");
    expect(prompt).toContain("file I/O lives only in the adapters package");
  });
});
