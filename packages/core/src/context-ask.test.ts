import type {
  BaseRefResolution,
  CouncilResolveContext,
  KnowledgeSet,
  SnapshotFileEntry,
  SymbolShard,
  WorkspaceScope,
} from "@rennet/types";
import { KNOWLEDGE_SCHEMA_VERSION } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { runContextAsk } from "./context-ask";
import type { HarnessTurnResult } from "./harness-run-turn";
import { createInvocationBudget } from "./invocation-budget";
import { type LoadedSnapshot, materializeSnapshot } from "./project-context";
import { buildSnapshot, type SnapshotStructuralInputs } from "./project-snapshot";

// ── A small coherent snapshot, built through the real builder ──────────────────

const B_A = "blob-a";
const B_M = "blob-m";

const files: SnapshotFileEntry[] = [
  { path: "packages/core/src/a.ts", blobOid: B_A, size: 30, mode: "100644" },
  { path: "packages/app/src/main.ts", blobOid: B_M, size: 20, mode: "100644" },
];

const scopes: WorkspaceScope[] = [
  {
    name: "@x/core",
    root: "packages/core",
    sourceRoot: "packages/core/src",
    type: "library",
    private: true,
    tags: [],
  },
];

const symbolShards: SymbolShard[] = [
  {
    blobOid: B_A,
    extractor: "structural-ts-v1",
    symbols: [{ name: "foo", kind: "function", line: 1 }],
  },
];

const inputs: SnapshotStructuralInputs = {
  repoKey: "/repo/.git",
  baseRef: "main",
  baseRefResolution: "symbolic-head" as BaseRefResolution,
  baseOid: "oid-abc",
  files,
  scopes,
  edges: [],
  entryPoints: [],
  tests: [],
  ownership: [],
  conventions: [],
};

function loaded(): LoadedSnapshot {
  const built = buildSnapshot(inputs, symbolShards);
  const result = materializeSnapshot(built.manifest, (digest) => built.shards.get(digest));
  if (!result.ok) throw new Error(`materialize failed: ${result.slots.join(",")}`);
  return result.snapshot;
}

const KNOWLEDGE: KnowledgeSet = {
  schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
  repoKey: "/repo/.git",
  baseOid: "oid-abc",
  snapshotFingerprint: "fp-1",
  generator: "knowledge-gen@1",
  statements: [
    {
      id: "k1",
      subject: "@x/core",
      aspect: "purpose",
      claim: "core holds the deterministic reads",
      evidence: [
        {
          path: "packages/core/src/a.ts",
          blobOid: B_A,
          symbol: "foo",
          lines: { startLine: 1 },
        },
      ],
      confidence: "high",
      status: "hypothesis",
      provenance: { generator: "knowledge-gen@1", model: "m", apiKeySource: "none" },
      learnedAgainst: { baseOid: "oid-abc", snapshotFingerprint: "fp-1" },
    },
  ],
};

const COUNCIL: CouncilResolveContext = { availability: { installed: ["claude-code"] } };

function emit(body: unknown): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async () => ({ status: "emitted", body });
}

function fail(message: string): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async () => ({ status: "failed", message });
}

describe("runContextAsk", () => {
  it("validates an evidence-backed answer, resolving anchors to authoritative blobOids", async () => {
    const result = await runContextAsk({
      snapshot: loaded(),
      knowledgeSet: KNOWLEDGE,
      query: { question: "what is in core?" },
      council: COUNCIL,
      runTurn: emit({
        answer: "core holds the deterministic snapshot reads",
        confidence: "high",
        evidence: [
          {
            evidenceId: "k1:0",
            path: "packages/core/src/a.ts",
            symbol: "foo",
            startLine: 1,
          },
        ],
      }),
    });
    expect(result.status).toBe("answered");
    if (result.status !== "answered") throw new Error("unreachable");
    expect(result.answer.evidence).toHaveLength(1);
    expect(result.answer.evidence[0]?.blobOid).toBe(B_A);
    expect(result.answer.confidence).toBe("high");
    expect(result.answer.unanswered).toBeUndefined();
    // The cost report is always present, with the resolved model + trace.
    expect(result.answer.cost.model).not.toBeNull();
    expect(result.answer.cost.resolution.jobId).toBe("context-ask-fetch");
  });

  it("rejects an evidence-free answer as a failed ask, never a clean answer", async () => {
    const result = await runContextAsk({
      snapshot: loaded(),
      knowledgeSet: KNOWLEDGE,
      query: { question: "what is in core?" },
      council: COUNCIL,
      // A confident answer citing a path NOT in the snapshot ⇒ zero resolvable evidence.
      runTurn: emit({
        answer: "core does something",
        confidence: "high",
        evidence: [{ path: "packages/ghost/src/nope.ts" }],
      }),
      maxRetries: 0,
    });
    expect(result.status).toBe("failed");
  });

  it("rejects a fabricated citation to a real file with an unoffered symbol/span", async () => {
    const result = await runContextAsk({
      snapshot: loaded(),
      knowledgeSet: null,
      query: { question: "is MFA mandatory?" },
      council: COUNCIL,
      runTurn: emit({
        answer: "MFA is mandatory",
        confidence: "high",
        evidence: [
          {
            evidenceId: "invented:0",
            path: "packages/core/src/a.ts",
            symbol: "requireMfa",
            startLine: 999999,
          },
        ],
      }),
      maxRetries: 0,
    });
    expect(result.status).toBe("failed");
  });

  it.each([
    { symbol: "requireMfa", startLine: 1 },
    { symbol: "foo", startLine: 999999 },
  ])(
    "rejects invented $symbol/$startLine bounds even when the evidence id and path are real",
    async ({ symbol, startLine }) => {
      const result = await runContextAsk({
        snapshot: loaded(),
        knowledgeSet: KNOWLEDGE,
        query: { question: "is MFA mandatory?" },
        council: COUNCIL,
        runTurn: emit({
          answer: "MFA is mandatory",
          confidence: "high",
          evidence: [
            {
              evidenceId: "k1:0",
              path: "packages/core/src/a.ts",
              symbol,
              startLine,
            },
          ],
        }),
        maxRetries: 0,
      });
      expect(result.status).toBe("failed");
    },
  );

  it("shows the model identifiable claim evidence and labels file names non-evidence", async () => {
    let prompt = "";
    await runContextAsk({
      snapshot: loaded(),
      knowledgeSet: KNOWLEDGE,
      query: { question: "what is in core?" },
      council: COUNCIL,
      runTurn: async (value) => {
        prompt = value;
        return {
          status: "emitted",
          body: {
            answer: "core holds deterministic reads",
            confidence: "high",
            evidence: [{ evidenceId: "k1:0", path: "packages/core/src/a.ts" }],
          },
        };
      },
      maxRetries: 0,
    });
    expect(prompt).toContain("evidence=k1:0 statement=k1");
    expect(prompt).toContain("claim: core holds the deterministic reads");
    expect(prompt).toContain("PROJECT FILE NAMES (navigation only; NOT evidence)");
  });

  it("never offers a rejected statement as evidence to the orchestrator", async () => {
    let prompt = "";
    const [only] = KNOWLEDGE.statements;
    if (!only) throw new Error("fixture");
    const rejected: KnowledgeSet = {
      ...KNOWLEDGE,
      statements: [{ ...only, status: "rejected" }],
    };
    await runContextAsk({
      snapshot: loaded(),
      knowledgeSet: rejected,
      query: { question: "what is in core?" },
      council: COUNCIL,
      runTurn: async (value) => {
        prompt = value;
        return {
          status: "emitted",
          body: {
            answer: "",
            confidence: "low",
            evidence: [],
            unanswered: { reason: "no evidence" },
          },
        };
      },
      maxRetries: 0,
    });
    // The human disowned k1; its claim must not reach the model as offered evidence.
    expect(prompt).not.toContain("core holds the deterministic reads");
    expect(prompt).not.toContain("statement=k1");
  });

  it("returns unanswered-with-reason as a first-class success", async () => {
    const result = await runContextAsk({
      snapshot: loaded(),
      knowledgeSet: KNOWLEDGE,
      query: { question: "how does the generated bundle behave at runtime?" },
      council: COUNCIL,
      runTurn: emit({
        answer: "",
        confidence: "low",
        evidence: [],
        unanswered: { reason: "the snapshot does not cover generated code" },
      }),
    });
    expect(result.status).toBe("unanswered");
    if (result.status !== "unanswered") throw new Error("unreachable");
    expect(result.answer.unanswered?.reason).toContain("generated code");
    expect(result.answer.cost.turns).toBeGreaterThan(0);
  });

  it("resolves the thorough seat when budgetHint is thorough", async () => {
    const result = await runContextAsk({
      snapshot: loaded(),
      knowledgeSet: KNOWLEDGE,
      query: { question: "what is in core?", budgetHint: "thorough" },
      council: COUNCIL,
      runTurn: emit({
        answer: "core holds reads",
        confidence: "medium",
        evidence: [{ evidenceId: "k1:0", path: "packages/core/src/a.ts" }],
      }),
    });
    expect(result.status).toBe("answered");
    if (result.status !== "answered") throw new Error("unreachable");
    expect(result.answer.cost.resolution.jobId).toBe("context-ask-thorough");
  });

  it("meters spend into cost and NEVER refuses — a no-headroom thorough ask still answers", async () => {
    const budget = createInvocationBudget(0); // deliberate spend-nothing ceiling
    const result = await runContextAsk({
      snapshot: loaded(),
      knowledgeSet: KNOWLEDGE,
      query: { question: "what is in core?", budgetHint: "thorough" },
      council: COUNCIL,
      budget,
      runTurn: emit({
        answer: "core holds reads",
        confidence: "medium",
        evidence: [{ evidenceId: "k1:0", path: "packages/core/src/a.ts" }],
      }),
      maxRetries: 0,
    });
    // The ask STILL answers despite no headroom, and reports the overage.
    expect(result.status).toBe("answered");
    if (result.status !== "answered") throw new Error("unreachable");
    expect(result.answer.cost.overage).toBe(true);
    expect(result.answer.cost.budgetGranted).toBe(false);
    expect(result.answer.cost.turns).toBe(1);
  });

  it("reports a turn failure as a failed ask", async () => {
    const result = await runContextAsk({
      snapshot: loaded(),
      knowledgeSet: KNOWLEDGE,
      query: { question: "what is in core?" },
      council: COUNCIL,
      runTurn: fail("the harness turn was cancelled"),
      maxRetries: 0,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.cost.turns).toBe(1);
  });
});
