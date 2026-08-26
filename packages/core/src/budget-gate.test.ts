/**
 * The live invocation-budget gate on the two model runners (issue #69, bead
 * p0wwp). These tests prove the money-critical property: a turn over the ceiling
 * is refused AT RUNTIME (retries counted), and a refusal falls to the
 * deterministic floor rather than crashing. A runner that did not consult the
 * budget would issue every retry and fail these tests — the red-then-green proof
 * for the gate.
 */

import { DECOMPOSITION_PROPOSAL_CONTRACT, ORDERING_CONTRACT } from "@rennet/instructions";
import type {
  DecompositionProposalBody,
  PatchFile,
  Patchset,
  RspCapabilitySnapshot,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  buildOfferedManifest,
  type DecompositionProvenanceSeed,
  type DecompositionTurnResult,
  runDecompositionAngle,
} from "./angle-generation";
import { decompose } from "./decomposition";
import { createInvocationBudget } from "./invocation-budget";
import { type OrderingTurnResult, runOrderingPass } from "./ordering-pass";

const CAPABILITY: RspCapabilitySnapshot = {
  structuredOutput: {
    implementedByAdapter: true,
    advertisedByHarness: true,
    availableInSession: true,
  },
  perCallModelSelection: {
    implementedByAdapter: false,
    advertisedByHarness: false,
    availableInSession: false,
  },
};
const SEED: DecompositionProvenanceSeed = {
  harness: "claude-code",
  harnessVersion: "2.1.220",
  adapterVersion: "0.1.0",
  model: "opus-4.8",
  modelReportedBy: "config",
  capability: CAPABILITY,
};

function file(path: string, patch: string): PatchFile {
  return { path, status: "modified", additions: null, deletions: null, binary: false, patch };
}
function patch(path: string, lines: string[]): string {
  const n = lines.length;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${n} +1,${n} @@\n${lines.join("\n")}\n`;
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
  files: [file("src/a.ts", patch("src/a.ts", ["+export const a = 1;"]))],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};
const DECOMPOSITION = decompose(PATCHSET);

const PROPOSAL: DecompositionProposalBody = {
  chunks: [
    { chunkId: "c1", title: "a", hunkIds: ["h1"], angles: ["sequence"], rationale: "base" },
    { chunkId: "c2", title: "b", hunkIds: ["h2"], angles: ["sequence"], rationale: "next" },
  ],
  edges: [],
  readingOrder: ["c1", "c2"],
  residue: [],
};

describe("runDecompositionAngle — the live budget gate (acceptance 2)", () => {
  it("refuses the retry at runtime once the budget is spent, and the floor stands", async () => {
    // A turn that always emits an invalid body (rejected), so the runner WANTS to
    // retry maxRetries times. With a budget of ONE, only the first turn may run.
    const alwaysReject = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({
        status: "emitted",
        body: { not: "a proposal" },
      }),
    );
    const budget = createInvocationBudget(1);

    const result = await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest: buildOfferedManifest(DECOMPOSITION),
      provenance: SEED,
      runTurn: alwaysReject,
      budget,
      maxRetries: 2,
    });

    // The budget of one permitted exactly one turn; the retry was refused at
    // runtime BEFORE a second runTurn. A runner that ignored the budget would
    // have called this three times.
    expect(alwaysReject).toHaveBeenCalledTimes(1);
    expect(budget.consumed).toBe(1);
    expect(result.budgetRefused).toBe(true);
    expect(result.attempts.at(-1)?.outcome).toBe("budget-refused");
    // The floor stood: an admitted deterministic proposal, not a crash.
    expect(result.usedFallback).toBe(true);
    expect(result.admitted).toBe(true);
    expect(result.document.provenance.route).toBe("deterministic");
  });

  it("with an already-exhausted budget, no turn runs at all", async () => {
    const turn = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: {} }),
    );
    const budget = createInvocationBudget(0);

    const result = await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest: buildOfferedManifest(DECOMPOSITION),
      provenance: SEED,
      runTurn: turn,
      budget,
    });

    expect(turn).not.toHaveBeenCalled();
    expect(result.budgetRefused).toBe(true);
    expect(result.usedFallback).toBe(true);
  });

  it("an ABSENT budget runs UNGATED — every turn runs, no ceiling (#260)", async () => {
    // #260 inverts #95: an absent budget is no ceiling, not no spend. The runner
    // spends turns ungated. Red-provable: restore the fail-closed absent refusal
    // and this reds (no turn would run, budgetRefused would flip true).
    const alwaysReject = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({
        status: "emitted",
        body: { not: "a proposal" },
      }),
    );
    const result = await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest: buildOfferedManifest(DECOMPOSITION),
      provenance: SEED,
      runTurn: alwaysReject,
      maxRetries: 2,
      // budget deliberately omitted — no ceiling, so every attempt runs.
    });
    // Every attempt ran (first + two retries): the absent budget imposed no ceiling.
    expect(alwaysReject).toHaveBeenCalledTimes(3);
    expect(result.budgetRefused).toBe(false);
    // The floor still stands — but because the bodies were invalid, NOT the budget.
    expect(result.usedFallback).toBe(true);
  });
});

describe("runOrderingPass — the live budget gate", () => {
  it("an exhausted budget refuses the turn and the baseline stands", async () => {
    const turn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({
        status: "emitted",
        body: { readingOrder: ["c2", "c1"], rationale: "reorder" },
      }),
    );
    const budget = createInvocationBudget(0);

    const result = await runOrderingPass({
      proposal: PROPOSAL,
      patchsetId: "ps_1",
      contract: ORDERING_CONTRACT,
      provenance: SEED,
      runTurn: turn,
      budget,
    });

    expect(turn).not.toHaveBeenCalled();
    expect(result.budgetRefused).toBe(true);
    expect(result.usedFallback).toBe(true);
    expect(result.document.provenance.route).toBe("deterministic");
    // The baseline order is what stands.
    expect((result.document.body as { readingOrder: string[] }).readingOrder).toEqual(["c1", "c2"]);
  });

  it("an ABSENT budget runs UNGATED — the ordering turn runs and its reorder stands (#260)", async () => {
    const turn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({
        status: "emitted",
        body: { readingOrder: ["c2", "c1"], rationale: "reorder" },
      }),
    );
    const result = await runOrderingPass({
      proposal: PROPOSAL,
      patchsetId: "ps_1",
      contract: ORDERING_CONTRACT,
      provenance: SEED,
      runTurn: turn,
      // budget deliberately omitted — no ceiling, so the turn runs.
    });
    expect(turn).toHaveBeenCalledTimes(1);
    expect(result.budgetRefused).toBe(false);
    // The model turn ran and its reorder was admitted — NOT the deterministic baseline.
    expect(result.usedFallback).toBe(false);
    expect((result.document.body as { readingOrder: string[] }).readingOrder).toEqual(["c2", "c1"]);
  });

  it("a MALFORMED budget produces REAL work — the turn runs and its order is admitted (#260)", async () => {
    // The lead's guard for #260: a malformed budget must produce a real review, not
    // merely the absence of a refusal. A NaN ceiling falls back to the default, so
    // the ordering turn RUNS and its reorder is ADMITTED (usedFallback false) — work
    // actually happened, it is not the deterministic baseline and it is not a no-op.
    const turn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({
        status: "emitted",
        body: { readingOrder: ["c2", "c1"], rationale: "reorder" },
      }),
    );
    const budget = createInvocationBudget(Number.NaN);
    const result = await runOrderingPass({
      proposal: PROPOSAL,
      patchsetId: "ps_1",
      contract: ORDERING_CONTRACT,
      provenance: SEED,
      runTurn: turn,
      budget,
    });
    expect(turn).toHaveBeenCalledTimes(1);
    expect(result.budgetRefused).toBe(false);
    expect(result.usedFallback).toBe(false);
    expect((result.document.body as { readingOrder: string[] }).readingOrder).toEqual(["c2", "c1"]);
  });

  it("shares one budget across a decomposition retry and an ordering turn", async () => {
    // Budget of TWO: the decomposition proposal (1) + its first retry (2) exhaust
    // it, so the ordering pass — sharing the same budget — gets nothing.
    const budget = createInvocationBudget(2);
    const rejectTwice = vi.fn(
      async (): Promise<DecompositionTurnResult> => ({ status: "emitted", body: { bad: true } }),
    );
    const orderTurn = vi.fn(
      async (): Promise<OrderingTurnResult> => ({
        status: "emitted",
        body: { readingOrder: ["c2", "c1"], rationale: "x" },
      }),
    );

    await runDecompositionAngle({
      decomposition: DECOMPOSITION,
      contract: DECOMPOSITION_PROPOSAL_CONTRACT,
      manifest: buildOfferedManifest(DECOMPOSITION),
      provenance: SEED,
      runTurn: rejectTwice,
      budget,
      maxRetries: 2,
    });
    const ordering = await runOrderingPass({
      proposal: PROPOSAL,
      patchsetId: "ps_1",
      contract: ORDERING_CONTRACT,
      provenance: SEED,
      runTurn: orderTurn,
      budget,
    });

    // The decomposition spent the whole budget of two (first + one retry); the
    // ordering pass was refused before any turn.
    expect(rejectTwice).toHaveBeenCalledTimes(2);
    expect(orderTurn).not.toHaveBeenCalled();
    expect(budget.consumed).toBe(2);
    expect(ordering.budgetRefused).toBe(true);
  });
});
