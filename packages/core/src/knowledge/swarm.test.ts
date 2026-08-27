import { describe, expect, it } from "vitest";
import type { HarnessTurnResult } from "../harness-run-turn";
import type { KnowledgeSnapshotContext } from "../knowledge-generation";
import type { PartitionSlice } from "./partition";
import { runMapVerify, runPartitionWorker } from "./swarm";

const SNAPSHOT: KnowledgeSnapshotContext = {
  repoKey: "repo",
  baseOid: "a".repeat(40),
  snapshotFingerprint: "fp-1",
  files: [
    { path: "src/a.ts", blobOid: "blob-a" },
    { path: "src/b.ts", blobOid: "blob-b" },
    { path: "lib/c.ts", blobOid: "blob-c" },
  ],
  scopes: [{ name: "src", root: "src" }],
};

const SLICE: PartitionSlice = {
  id: "src",
  files: [
    { path: "src/a.ts", blobOid: "blob-a" },
    { path: "src/b.ts", blobOid: "blob-b" },
  ],
};

const PROVENANCE = { model: "test-model", apiKeySource: null };

const emitted = (body: unknown): HarnessTurnResult => ({ status: "emitted", body });

function rawStatement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: "src",
    aspect: "purpose",
    claim: "src holds the sources",
    confidence: "high",
    evidence: [{ path: "src/a.ts" }],
    ...overrides,
  };
}

describe("runPartitionWorker", () => {
  it("mints anchored hypotheses and keeps the hint in the envelope only", async () => {
    const result = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({ statements: [rawStatement({ hint: "pattern may continue in lib/" })] }),
    });
    expect(result.status).toBe("ok");
    expect(result.statements).toHaveLength(1);
    const entry = result.statements[0];
    expect(entry?.hint).toBe("pattern may continue in lib/");
    // The statement itself is hypothesis-labelled, blobOid-anchored, and hint-free.
    expect(entry?.statement.status).toBe("hypothesis");
    expect(entry?.statement.evidence[0]?.blobOid).toBe("blob-a");
    expect(JSON.stringify(entry?.statement)).not.toContain("hint");
  });

  it("drops unresolvable anchors and unanchored statements (honesty contract)", async () => {
    const result = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: [
            rawStatement({ evidence: [{ path: "src/invented.ts" }] }), // unresolvable ⇒ unanchored ⇒ dropped
            rawStatement({
              claim: "b is real",
              evidence: [{ path: "src/invented.ts" }, { path: "src/b.ts" }],
            }),
          ],
        }),
    });
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]?.statement.claim).toBe("b is real");
    expect(result.statements[0]?.statement.evidence).toEqual([
      { path: "src/b.ts", blobOid: "blob-b" },
    ]);
    expect(result.droppedStatements).toBe(1);
    expect(result.droppedAnchors).toBe(2);
  });

  it("resolves to an honest failed after exhausted retries", async () => {
    const result = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () => ({ status: "failed", message: "turn exploded" }),
      maxRetries: 1,
    });
    expect(result).toMatchObject({ status: "failed", failureReason: "turn exploded", attempts: 2 });
  });
});

describe("runMapVerify", () => {
  async function workerResults() {
    const worker = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: [
            rawStatement({ hint: "check lib/ too" }),
            rawStatement({ claim: "b wires the adapters", evidence: [{ path: "src/b.ts" }] }),
          ],
        }),
    });
    return [worker];
  }

  it("flips hypotheses per the seat's verdicts; unverdicted ids stay hypothesis", async () => {
    const results = await workerResults();
    const [first, second] = results[0]?.statements ?? [];
    const verify = await runMapVerify({
      workerResults: results,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          verdicts: [
            { id: first?.statement.id, verdict: "confirmed" },
            { id: "no-such-id", verdict: "rejected" }, // unknown id ⇒ ignored
          ],
          crossCutting: [],
        }),
    });
    expect(verify.status).toBe("ok");
    expect(verify.confirmed).toBe(1);
    expect(verify.rejected).toBe(0);
    const byId = new Map(verify.set?.statements.map((s) => [s.id, s.status]));
    expect(byId.get(first?.statement.id ?? "")).toBe("confirmed");
    expect(byId.get(second?.statement.id ?? "")).toBe("hypothesis");
  });

  it("mints anchored cross-cutting statements as hypotheses and discards hints from the set", async () => {
    const results = await workerResults();
    const verify = await runMapVerify({
      workerResults: results,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          verdicts: [],
          crossCutting: [
            rawStatement({
              subject: "src+lib",
              claim: "src and lib share the port pattern",
              evidence: [{ path: "src/a.ts" }, { path: "lib/c.ts" }],
            }),
            rawStatement({
              subject: "ghost",
              claim: "unanchored",
              evidence: [{ path: "nope.ts" }],
            }),
          ],
        }),
    });
    expect(verify.crossCutting).toBe(1);
    const cross = verify.set?.statements.find((s) => s.subject === "src+lib");
    expect(cross?.status).toBe("hypothesis");
    expect(cross?.evidence.map((a) => a.blobOid)).toEqual(["blob-a", "blob-c"]);
    // No hint text anywhere in the synthesized set (envelope-only, dies at synthesis).
    expect(JSON.stringify(verify.set)).not.toContain("check lib/ too");
    expect(verify.droppedStatements).toBe(1);
  });

  it("dedups by statement id across workers and cross-cutting re-mints", async () => {
    const results = await workerResults();
    const duplicate = results[0]?.statements[0]?.statement;
    const verify = await runMapVerify({
      workerResults: [...results, ...results], // same worker result twice ⇒ duplicate ids
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          verdicts: [],
          // The seat re-emits an identical claim ⇒ same content-addressed id ⇒ deduped.
          crossCutting: [rawStatement()],
        }),
    });
    const ids = verify.set?.statements.map((s) => s.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === duplicate?.id)).toHaveLength(1);
  });
});
