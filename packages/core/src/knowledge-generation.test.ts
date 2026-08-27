import type { KnowledgeSet } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { HarnessTurnResult } from "./harness-run-turn";
import { createInvocationBudget } from "./invocation-budget";
import { knowledgeStatementId, statementIntersectsChange } from "./knowledge";
import {
  type KnowledgeSnapshotContext,
  runKnowledgeDeltaPass,
  runKnowledgeEnrichment,
} from "./knowledge-generation";

const SNAPSHOT: KnowledgeSnapshotContext = {
  repoKey: "-repo",
  baseOid: "oid-1",
  snapshotFingerprint: "fp-1",
  files: [
    { path: "packages/a/src/index.ts", blobOid: "blob-a" },
    { path: "packages/b/src/index.ts", blobOid: "blob-b" },
  ],
  scopes: [
    { name: "@t/a", root: "packages/a" },
    { name: "@t/b", root: "packages/b" },
  ],
};

/** A runTurn that emits a fixed body once. */
function emit(body: unknown): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async () => ({ status: "emitted", body });
}

function fail(message: string): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async () => ({ status: "failed", message });
}

const SEED = { model: "claude-x", apiKeySource: "none" };

describe("runKnowledgeEnrichment", () => {
  it("mints statements with anchors resolved to authoritative blobOids, all labelled hypothesis", async () => {
    const result = await runKnowledgeEnrichment({
      snapshot: SNAPSHOT,
      provenance: SEED,
      budget: createInvocationBudget(2),
      runTurn: emit({
        statements: [
          {
            subject: "@t/a",
            aspect: "purpose",
            claim: "scope a is the deterministic snapshot source",
            confidence: "high",
            evidence: [{ path: "packages/a/src/index.ts", symbol: "buildSnapshot", startLine: 10 }],
          },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    const set = result.set as KnowledgeSet;
    expect(set.statements).toHaveLength(1);
    const s = set.statements[0];
    expect(s?.status).toBe("hypothesis");
    // The model cited a path; the runner stamped the authoritative blobOid.
    expect(s?.evidence[0]).toEqual({
      path: "packages/a/src/index.ts",
      blobOid: "blob-a",
      symbol: "buildSnapshot",
      lines: { startLine: 10 },
    });
    expect(s?.provenance.model).toBe("claude-x");
    expect(s?.learnedAgainst).toEqual({ baseOid: "oid-1", snapshotFingerprint: "fp-1" });
  });

  it("drops an anchor citing an unknown path, and a statement left unanchored", async () => {
    const result = await runKnowledgeEnrichment({
      snapshot: SNAPSHOT,
      provenance: SEED,
      budget: createInvocationBudget(2),
      runTurn: emit({
        statements: [
          {
            subject: "ghost",
            aspect: "purpose",
            claim: "about a file that does not exist",
            confidence: "low",
            evidence: [{ path: "packages/z/gone.ts" }],
          },
          {
            subject: "@t/a",
            aspect: "convention",
            claim: "kept",
            confidence: "medium",
            evidence: [{ path: "packages/z/gone.ts" }, { path: "packages/a/src/index.ts" }],
          },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    const set = result.set as KnowledgeSet;
    // First statement dropped (no resolvable anchor); second kept with only the resolvable anchor.
    expect(set.statements.map((s) => s.subject)).toEqual(["@t/a"]);
    expect(set.statements[0]?.evidence).toHaveLength(1);
    expect(result.droppedStatements).toBe(1);
    expect(result.droppedAnchors).toBe(2);
  });

  it("runs UNGATED when the budget is absent — an absent budget is no ceiling, not no spend (#260)", async () => {
    let called = false;
    const result = await runKnowledgeEnrichment({
      snapshot: SNAPSHOT,
      provenance: SEED,
      runTurn: async () => {
        called = true;
        return { status: "emitted", body: { statements: [] } };
      },
      // budget omitted — #260: no ceiling, the turn runs.
    });
    expect(result.status).toBe("ok");
    expect(result.budgetRefused).toBe(false);
    expect(called).toBe(true);
  });

  it("resolves to failed after every turn fails", async () => {
    const result = await runKnowledgeEnrichment({
      snapshot: SNAPSHOT,
      provenance: SEED,
      budget: createInvocationBudget(3),
      maxRetries: 1,
      runTurn: fail("model exploded"),
    });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("model exploded");
  });
});

describe("runKnowledgeDeltaPass", () => {
  const priorSet: KnowledgeSet = {
    schemaVersion: 1,
    repoKey: "-repo",
    baseOid: "oid-0",
    snapshotFingerprint: "fp-0",
    generator: "knowledge-gen@1",
    statements: [
      {
        id: "survivor",
        subject: "@t/b",
        aspect: "purpose",
        claim: "b is unchanged",
        evidence: [{ path: "packages/b/src/index.ts", blobOid: "blob-b" }],
        confidence: "high",
        status: "hypothesis",
        provenance: { generator: "knowledge-gen@1", model: null, apiKeySource: null },
        learnedAgainst: { baseOid: "oid-0", snapshotFingerprint: "fp-0" },
      },
      {
        id: "changed",
        subject: "@t/a",
        aspect: "purpose",
        claim: "a's old behaviour",
        evidence: [{ path: "packages/a/src/index.ts", blobOid: "blob-a-old" }],
        confidence: "medium",
        status: "hypothesis",
        provenance: { generator: "knowledge-gen@1", model: null, apiKeySource: null },
        learnedAgainst: { baseOid: "oid-0", snapshotFingerprint: "fp-0" },
      },
    ],
  };

  it("carries untouched survivors verbatim and re-adjudicates only changed regions", async () => {
    const result = await runKnowledgeDeltaPass({
      snapshot: SNAPSHOT,
      priorSet,
      changedPaths: ["packages/a/src/index.ts"],
      provenance: SEED,
      budget: createInvocationBudget(2),
      runTurn: emit({
        statements: [
          {
            subject: "@t/a",
            aspect: "purpose",
            claim: "a's NEW behaviour",
            confidence: "high",
            evidence: [{ path: "packages/a/src/index.ts" }],
          },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.carried).toBe(1);
    expect(result.invalidated.map((s) => s.id)).toEqual(["changed"]);
    const set = result.set as KnowledgeSet;
    const claims = set.statements.map((s) => s.claim).sort();
    // The survivor is carried; the changed statement is replaced by the re-adjudicated one.
    expect(claims).toEqual(["a's NEW behaviour", "b is unchanged"]);
    expect(set.baseOid).toBe("oid-1"); // pinned to the NEW snapshot
  });

  it("is a skipped no-op when nothing changed", async () => {
    let called = false;
    const result = await runKnowledgeDeltaPass({
      snapshot: SNAPSHOT,
      priorSet,
      changedPaths: [],
      provenance: SEED,
      budget: createInvocationBudget(2),
      runTurn: async () => {
        called = true;
        return { status: "emitted", body: { statements: [] } };
      },
    });
    expect(result.status).toBe("skipped");
    expect(called).toBe(false);
  });

  it("preserves a human disposition on an unchanged-region survivor across a delta", async () => {
    // A confirmed and a rejected statement in an UNTOUCHED region must survive a delta
    // verbatim — the human's disposition is a recorded state, not a re-derivable one, so
    // the carry path may never reset it to `hypothesis`.
    const [survivor, changed] = priorSet.statements;
    if (!survivor || !changed) throw new Error("fixture");
    const disposedPrior: KnowledgeSet = {
      ...priorSet,
      statements: [
        { ...survivor, id: "confirmed-survivor", status: "confirmed" },
        { ...survivor, id: "rejected-survivor", status: "rejected" },
        changed,
      ],
    };
    const result = await runKnowledgeDeltaPass({
      snapshot: SNAPSHOT,
      priorSet: disposedPrior,
      changedPaths: ["packages/a/src/index.ts"],
      provenance: SEED,
      budget: createInvocationBudget(2),
      runTurn: emit({ statements: [] }),
    });
    expect(result.status).toBe("ok");
    const set = result.set as KnowledgeSet;
    const byId = new Map(set.statements.map((s) => [s.id, s.status]));
    expect(byId.get("confirmed-survivor")).toBe("confirmed");
    expect(byId.get("rejected-survivor")).toBe("rejected");
  });

  it("does not resurrect a rejected claim when a changed-path re-adjudication re-mints its exact id", () => {
    // A mode-only (or otherwise same-content) change puts the cited file in
    // changedPaths without moving its blobOid, so the model can re-emit the very
    // same claim. Its content id is identical — the human's rejection must hold,
    // never flip back to hypothesis.
    const claim = "a is deliberately excluded";
    const evidence = [{ path: "packages/a/src/index.ts", blobOid: "blob-a" }];
    const id = knowledgeStatementId({ subject: "@t/a", aspect: "purpose", claim, evidence });
    const rejectedPrior: KnowledgeSet = {
      ...priorSet,
      statements: [
        {
          id,
          subject: "@t/a",
          aspect: "purpose",
          claim,
          evidence,
          confidence: "high",
          status: "rejected",
          provenance: { generator: "knowledge-gen@1", model: null, apiKeySource: null },
          learnedAgainst: { baseOid: "oid-0", snapshotFingerprint: "fp-0" },
        },
      ],
    };
    return runKnowledgeDeltaPass({
      snapshot: SNAPSHOT,
      priorSet: rejectedPrior,
      changedPaths: ["packages/a/src/index.ts"],
      provenance: SEED,
      budget: createInvocationBudget(2),
      runTurn: emit({
        statements: [
          {
            subject: "@t/a",
            aspect: "purpose",
            claim,
            confidence: "high",
            evidence: [{ path: "packages/a/src/index.ts" }],
          },
        ],
      }),
    }).then((result) => {
      expect(result.status).toBe("ok");
      const set = result.set as KnowledgeSet;
      const restated = set.statements.find((s) => s.id === id);
      expect(restated?.status).toBe("rejected");
    });
  });

  it("statementIntersectsChange detects a cited changed path", () => {
    const [survivor, changed] = priorSet.statements;
    if (!survivor || !changed) throw new Error("fixture");
    const changedPaths = new Set(["packages/a/src/index.ts"]);
    expect(statementIntersectsChange(changed, changedPaths)).toBe(true);
    expect(statementIntersectsChange(survivor, changedPaths)).toBe(false);
  });
});
