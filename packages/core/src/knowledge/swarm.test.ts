import { describe, expect, it } from "vitest";
import type { HarnessTurnResult } from "../harness-run-turn";
import type { KnowledgeSnapshotContext } from "./mint";
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
  neighbors: [],
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

  it("drops off-slice citations: partition isolation is enforced at mint, not in the prompt", async () => {
    const result = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: [
            // lib/c.ts IS in the snapshot inventory but NOT in this worker's slice.
            rawStatement({ claim: "cites another slice", evidence: [{ path: "lib/c.ts" }] }),
            rawStatement(),
          ],
        }),
    });
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]?.statement.evidence[0]?.path).toBe("src/a.ts");
    expect(result.droppedStatements).toBe(1);
    expect(result.droppedAnchors).toBe(1);
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

  it("chunks the seat's prompt so a large swarm never builds one unbounded turn", async () => {
    // The shipped bug: every partition's statements went into ONE prompt. On a
    // real repository (199 partitions, ~1900 statements) that turn died with
    // "Prompt is too long" and the entire run's knowledge was discarded.
    const worker = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: Array.from({ length: 7 }, (_, index) =>
            rawStatement({ claim: `claim number ${index}` }),
          ),
        }),
    });
    const ids = worker.statements.map((entry) => entry.statement.id);
    expect(new Set(ids).size).toBe(7);

    const prompts: string[] = [];
    const verify = await runMapVerify({
      workerResults: [worker],
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      chunkSize: 3,
      runTurn: async (prompt) => {
        prompts.push(prompt);
        // The seat can only adjudicate what its OWN prompt carried.
        return emitted({
          verdicts: ids
            .filter((id) => prompt.includes(id))
            .map((id) => ({ id, verdict: "confirmed" })),
          crossCutting: [],
        });
      },
    });

    expect(prompts).toHaveLength(3); // ceil(7 / 3)
    for (const prompt of prompts) {
      expect(ids.filter((id) => prompt.includes(id)).length).toBeLessThanOrEqual(3);
    }
    // Every id appears in exactly one prompt, and every verdict merges back.
    expect(prompts.flatMap((prompt) => ids.filter((id) => prompt.includes(id))).sort()).toEqual(
      [...ids].sort(),
    );
    expect(verify.status).toBe("ok");
    expect(verify.confirmed).toBe(7);
    expect(verify.set?.statements.every((s) => s.status === "confirmed")).toBe(true);
  });

  it("a single failed chunk fails the whole pass (never a partial verify)", async () => {
    const worker = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: Array.from({ length: 4 }, (_, index) =>
            rawStatement({ claim: `claim number ${index}` }),
          ),
        }),
    });
    let turn = 0;
    const verify = await runMapVerify({
      workerResults: [worker],
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      chunkSize: 1,
      concurrency: 1,
      maxRetries: 0,
      runTurn: async () => {
        turn += 1;
        return turn === 2
          ? { status: "failed", message: "Prompt is too long" }
          : emitted({ verdicts: [], crossCutting: [] });
      },
    });
    expect(verify).toMatchObject({ status: "failed", failureReason: "Prompt is too long" });
    expect(verify.set).toBeUndefined();
    // …and the two chunks still queued behind it never ran: the pass is
    // all-or-nothing, so once one chunk fails every later turn is spend on a
    // verdict the first turn already decided.
    expect(turn).toBe(2);
  });

  it("dedups a statement id BEFORE chunking, so it cannot straddle a boundary", async () => {
    // Two partitions can mint the same content-addressed id (the delta path also
    // feeds `prior:reverify` beside a fresh run of the slice that owns it). When
    // the raw entries were chunked, one id landed in TWO chunks, could come back
    // with conflicting verdicts, and the later chunk silently overwrote the
    // earlier one. The duplicate here sits on opposite sides of the boundary.
    const mint = (statements: Record<string, unknown>[]) =>
      runPartitionWorker({
        slice: SLICE,
        snapshot: SNAPSHOT,
        provenance: PROVENANCE,
        runTurn: async () => emitted({ statements }),
      });
    const duplicate = rawStatement();
    const first = await mint([
      duplicate,
      rawStatement({ claim: "x one" }),
      rawStatement({ claim: "x two" }),
    ]);
    const second = await mint([
      rawStatement({ claim: "y one" }),
      rawStatement({ claim: "y two" }),
      duplicate,
    ]);
    const duplicateId = first.statements[0]?.statement.id;
    expect(duplicateId).toBe(second.statements[2]?.statement.id);

    const prompts: string[] = [];
    let turn = 0;
    const verify = await runMapVerify({
      workerResults: [first, second],
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      chunkSize: 3,
      concurrency: 1,
      runTurn: async (prompt) => {
        prompts.push(prompt);
        turn += 1;
        // The first turn confirms what it sees, the second rejects — so an id in
        // both chunks would come back with two opposed verdicts.
        const verdict = turn === 1 ? "confirmed" : "rejected";
        const ids = [...prompt.matchAll(/^- id=(\S+)$/gm)].map(([, id]) => id);
        return emitted({ verdicts: ids.map((id) => ({ id, verdict })), crossCutting: [] });
      },
    });

    // Unchunked at 3-per-turn, the six raw entries would straddle: chunk 1
    // [dup, x1, x2], chunk 2 [y1, y2, dup]. Deduped first, there are five.
    expect(prompts.filter((prompt) => prompt.includes(`id=${duplicateId}`))).toHaveLength(1);
    expect(verify.status).toBe("ok");
    expect(verify.set?.statements).toHaveLength(5);
    expect(verify.set?.statements.find((s) => s.id === duplicateId)?.status).toBe("confirmed");
    // No id is adjudicated twice: three confirmed in chunk 1, two rejected in chunk 2.
    expect(verify.confirmed).toBe(3);
    expect(verify.rejected).toBe(2);
  });

  it("runs a bounded cross-boundary pass over the chunks' own cross-cutting output", async () => {
    // Chunking cost the seat any pattern whose halves landed in different turns.
    // The second pass reads the chunks' OUTPUTS — never their hypotheses — so it
    // can see across the boundary without rebuilding the prompt that overflowed.
    const worker = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: Array.from({ length: 4 }, (_, index) =>
            rawStatement({ claim: `claim number ${index}` }),
          ),
        }),
    });
    const prompts: string[] = [];
    let turn = 0;
    const verify = await runMapVerify({
      workerResults: [worker],
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      chunkSize: 2,
      concurrency: 1,
      runTurn: async (prompt) => {
        prompts.push(prompt);
        turn += 1;
        return emitted({
          verdicts: [],
          crossCutting: [rawStatement({ claim: `chunk-local pattern ${turn}` })],
        });
      },
    });

    // Two hypothesis chunks, then exactly one synthesis turn over their output.
    expect(prompts).toHaveLength(3);
    const boundary = prompts[2] ?? "";
    expect(boundary).toContain("CROSS-BOUNDARY");
    expect(boundary).toContain("chunk-local pattern 1");
    expect(boundary).toContain("chunk-local pattern 2");
    // Bounded: it carries a digest LINE per chunk, not the chunks' hypotheses.
    expect(boundary).toContain("chunk 1: 2 hypotheses");
    for (const entry of worker.statements) {
      expect(boundary).not.toContain(entry.statement.claim);
    }
    // Its mint lands in the set beside the chunk-local ones.
    expect(verify.status).toBe("ok");
    expect(verify.crossCutting).toBe(3);
    const claims = verify.set?.statements.map((s) => s.claim) ?? [];
    expect(claims).toContain("chunk-local pattern 3");
  });

  it("skips the cross-boundary pass when one chunk already saw everything", async () => {
    const worker = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () => emitted({ statements: [rawStatement()] }),
    });
    let turns = 0;
    const verify = await runMapVerify({
      workerResults: [worker],
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () => {
        turns += 1;
        return emitted({ verdicts: [], crossCutting: [rawStatement({ claim: "one pattern" })] });
      },
    });
    expect(turns).toBe(1); // nothing straddles a boundary that does not exist
    expect(verify.status).toBe("ok");
  });

  it("keeps a good run when the cross-boundary pass fails (best-effort, not fatal)", async () => {
    const worker = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: [rawStatement(), rawStatement({ claim: "second claim" })],
        }),
    });
    let turn = 0;
    const verify = await runMapVerify({
      workerResults: [worker],
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      chunkSize: 1,
      concurrency: 1,
      maxRetries: 0,
      runTurn: async () => {
        turn += 1;
        return turn > 2
          ? { status: "failed", message: "Prompt is too long" }
          : emitted({ verdicts: [], crossCutting: [rawStatement({ claim: `pattern ${turn}` })] });
      },
    });
    // Both hypothesis chunks succeeded; only the bonus synthesis turn died.
    expect(verify.status).toBe("ok");
    expect(verify.crossCutting).toBe(2);
    expect(verify.set?.statements).toHaveLength(4);
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
