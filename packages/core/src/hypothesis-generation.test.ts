import type {
  HypothesisStructure,
  PatchFile,
  Patchset,
  RspCapabilitySnapshot,
} from "@rennet/protocol";
import { canonicalize, sha256Hex } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildOfferedManifest } from "./angle-generation";
import { decompose } from "./decomposition";
import {
  type HypothesisProvenanceSeed,
  type HypothesisTurnResult,
  hasRepoContext,
  runHypothesisPass,
} from "./hypothesis-generation";
import { createInvocationBudget } from "./invocation-budget";

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: null, deletions: null, binary: false, patch };
}

function patch(path: string, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] === "-" || l[0] === " ").length;
  const newCount = lines.filter((l) => l[0] === "+" || l[0] === " ").length;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldCount} +1,${newCount} @@\n${lines.join("\n")}\n`
  );
}

const PATCHSET: Patchset = {
  id: "ps_1",
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
    file("src/store.ts", patch("src/store.ts", ["+export const keyOf = (r: string) => r;"])),
    file("src/read.ts", patch("src/read.ts", ['+import { keyOf } from "./store";'])),
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const DECOMPOSITION = decompose(PATCHSET);
const MANIFEST = buildOfferedManifest(DECOMPOSITION);
const STRUCTURE: HypothesisStructure = {
  changedFiles: PATCHSET.files.map((f) => f.path),
  chunkTitles: DECOMPOSITION.chunks.map((c) => c.title),
};

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

const SEED: HypothesisProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "2.1.220",
  adapterVersion: "0.1.0",
  model: "claude-opus-4-8",
  modelReportedBy: "harness",
  capability: CAPABILITY,
};

/** A model hypothesis body with `count` risks, as the SDK would emit it (no riskId). */
function modelHypothesis(count = 6, riskOverrides: Record<string, unknown> = {}): unknown {
  const risks = Array.from({ length: count }, (_, i) => ({
    statement: `risk number ${i} that the store key is computed per branch instead of per repo`,
    severity: i % 2 === 0 ? "high" : "medium",
    disconfirmer: `check that hunk ${i} keys the store per repo root, not per branch`,
    ...riskOverrides,
  }));
  return {
    domain: "key the review store per repository so worktrees share one entry",
    scope: { inScope: ["store keying"], outOfScope: ["the knowledge layer"] },
    designExpectation: "resolve the key from realpath(git-common-dir), never the branch",
    risks,
  };
}

function emits(body: unknown): (prompt: string, attempt: number) => Promise<HypothesisTurnResult> {
  return (_p, attempt) =>
    Promise.resolve(
      attempt === 0 ? { status: "emitted", body } : { status: "failed", message: "no body" },
    );
}

describe("runHypothesisPass — the hypothesis-first pre-read (issue #178)", () => {
  it("feeds assembled context verbatim and preserves the absent-context prompt golden", async () => {
    const capture = async (assembledContext?: string): Promise<string> => {
      let prompt = "";
      await runHypothesisPass({
        patchsetId: PATCHSET.id,
        manifest: MANIFEST,
        structure: STRUCTURE,
        provenance: SEED,
        assembledContext,
        runTurn: (sent) => {
          prompt = sent;
          return Promise.resolve({ status: "emitted", body: modelHypothesis() });
        },
        budget: createInvocationBudget(5),
      });
      return prompt;
    };
    const context = "shared context line one\nshared context line two";
    const absent = await capture();
    const present = await capture(context);

    expect(sha256Hex(absent)).toBe(
      "24bab9099f70c717eef3a013372bd7695919ed71c1bf6ce1cbb1bc982dd5e0d0",
    );
    expect(absent).not.toContain("<<<rennet:layer context>>>");
    expect(present).toContain(
      `<<<rennet:layer context>>>\n${context}\n\n<<<rennet:layer payload>>>`,
    );
  });

  it("admits a well-formed hypothesis, minting each riskId (agents never mint identity)", async () => {
    const result = await runHypothesisPass({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      structure: STRUCTURE,
      provenance: SEED,
      runTurn: emits(modelHypothesis(7)),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("ok");
    expect(result.hypothesis?.risks).toHaveLength(7);
    // The runner mints every riskId — the model never supplied one.
    for (const risk of result.hypothesis?.risks ?? []) {
      expect(typeof risk.riskId).toBe("string");
      expect(risk.riskId.length).toBeGreaterThan(0);
    }
    expect(result.document?.docType).toBe("review.hypothesis");
    expect(result.report?.admitted).toBe(true);
  });

  it("mints the same default riskIds for the same patchset and risk content across independent passes", async () => {
    const body = modelHypothesis();
    const run = () =>
      runHypothesisPass({
        patchsetId: PATCHSET.id,
        manifest: MANIFEST,
        structure: STRUCTURE,
        provenance: SEED,
        runTurn: emits(body),
        budget: createInvocationBudget(5),
      });

    const first = await run();
    const second = await run();

    expect(first.hypothesis?.risks.map((risk) => risk.riskId)).toEqual(
      second.hypothesis?.risks.map((risk) => risk.riskId),
    );
    const firstRisk = first.hypothesis?.risks[0];
    expect(firstRisk?.riskId).toBe(
      sha256Hex(
        canonicalize({
          patchsetId: PATCHSET.id,
          statement: firstRisk?.statement,
          severity: firstRisk?.severity,
          disconfirmer: firstRisk?.disconfirmer,
        }),
      ),
    );
  });

  it("changes riskId with semantic content and not with risk ordering", async () => {
    const original = modelHypothesis() as Record<string, unknown> & { risks: readonly unknown[] };
    const reordered = { ...original, risks: [...original.risks].reverse() };
    const changed = modelHypothesis(6, {
      statement: "a different risk that the repository key ignores the common git directory",
    });
    const run = (body: unknown) =>
      runHypothesisPass({
        patchsetId: PATCHSET.id,
        manifest: MANIFEST,
        structure: STRUCTURE,
        provenance: SEED,
        runTurn: emits(body),
        budget: createInvocationBudget(5),
      });

    const baseline = await run(original);
    const reorderedResult = await run(reordered);
    const changedResult = await run(changed);
    const reorderedIds = new Map(
      reorderedResult.hypothesis?.risks.map((risk) => [risk.statement, risk.riskId]),
    );

    for (const risk of baseline.hypothesis?.risks ?? []) {
      expect(reorderedIds.get(risk.statement)).toBe(risk.riskId);
    }
    expect(changedResult.hypothesis?.risks[0]?.riskId).not.toBe(
      baseline.hypothesis?.risks[0]?.riskId,
    );
  });

  it("marks the repo context absent when none is supplied, and present when it is", async () => {
    const withoutContext = await runHypothesisPass({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      structure: STRUCTURE,
      provenance: SEED,
      runTurn: emits(modelHypothesis()),
      budget: createInvocationBudget(5),
    });
    expect(withoutContext.hypothesis?.repoContextPresent).toBe(false);

    const withContext = await runHypothesisPass({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      structure: STRUCTURE,
      repoContext: { summary: "an app-owned store keyed by the RepoRecord" },
      provenance: SEED,
      runTurn: emits(modelHypothesis()),
      budget: createInvocationBudget(5),
    });
    expect(withContext.hypothesis?.repoContextPresent).toBe(true);
  });

  it("forms a genuine prior — the payload carries structure + intent, NEVER the hunk bodies", async () => {
    let seenPrompt = "";
    await runHypothesisPass({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      structure: STRUCTURE,
      intent: { prTitle: "Key the store per repo" },
      provenance: SEED,
      runTurn: (prompt) => {
        seenPrompt = prompt;
        return Promise.resolve({ status: "emitted", body: modelHypothesis() });
      },
      budget: createInvocationBudget(5),
    });
    // Structure + intent reach the model...
    expect(seenPrompt).toContain("Key the store per repo");
    expect(seenPrompt).toContain("src/store.ts");
    // ...but the actual added CODE LINE from the hunk never does (a genuine prior).
    expect(seenPrompt).not.toContain("export const keyOf");
  });

  it("rejects atomically then retries when the model emits too few risks (V153), feeding the report back", async () => {
    let attempts = 0;
    const result = await runHypothesisPass({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      structure: STRUCTURE,
      provenance: SEED,
      runTurn: (_p, attempt) => {
        attempts += 1;
        // First attempt: 3 risks (below the 5-10 bound → whole doc rejected).
        // Second attempt: a valid 6.
        return Promise.resolve({
          status: "emitted",
          body: attempt === 0 ? modelHypothesis(3) : modelHypothesis(6),
        });
      },
      budget: createInvocationBudget(5),
    });
    expect(attempts).toBe(2);
    expect(result.attempts[0]?.outcome).toBe("rejected");
    expect(result.status).toBe("ok");
    expect(result.hypothesis?.risks).toHaveLength(6);
  });

  it("resolves to the LOUD failed state when every turn fails (no fabricated hypothesis)", async () => {
    const result = await runHypothesisPass({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      structure: STRUCTURE,
      provenance: SEED,
      runTurn: () => Promise.resolve({ status: "failed", message: "the harness transport died" }),
      budget: createInvocationBudget(5),
    });
    expect(result.status).toBe("failed");
    expect(result.hypothesis).toBeUndefined();
    expect(result.failureReason).toContain("transport");
  });

  it("runs UNGATED when NO budget is provided — an absent budget is no ceiling, not no spend (#260)", async () => {
    let turns = 0;
    const result = await runHypothesisPass({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      structure: STRUCTURE,
      provenance: SEED,
      runTurn: () => {
        turns += 1;
        return Promise.resolve({ status: "emitted", body: modelHypothesis() });
      },
      // budget omitted — #260: no ceiling, the turn runs.
    });
    expect(result.status).toBe("ok");
    expect(result.budgetRefused).toBe(false);
    expect(turns).toBe(1);
  });

  it("threads real token usage into provenance when the turn reports it (issue #186)", async () => {
    const result = await runHypothesisPass({
      patchsetId: PATCHSET.id,
      manifest: MANIFEST,
      structure: STRUCTURE,
      provenance: SEED,
      runTurn: () =>
        Promise.resolve({
          status: "emitted",
          body: modelHypothesis(),
          tokens: {
            input: 2,
            output: 100,
            cacheRead: 0,
            cacheWrite: 5000,
            reasoning: null,
            total: 5102,
          },
        }),
      budget: createInvocationBudget(5),
    });
    expect(result.document?.provenance.tokens.total).toBe(5102);
    expect(result.document?.provenance.tokens.cacheWrite).toBe(5000);
  });
});

describe("hasRepoContext", () => {
  it("is false for undefined / empty, true for a summary or files", () => {
    expect(hasRepoContext(undefined)).toBe(false);
    expect(hasRepoContext({})).toBe(false);
    expect(hasRepoContext({ summary: "  " })).toBe(false);
    expect(hasRepoContext({ summary: "real" })).toBe(true);
    expect(hasRepoContext({ files: [{ path: "a.ts" }] })).toBe(true);
  });
});
