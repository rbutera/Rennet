import { describe, expect, it } from "vitest";
import type { HarnessTurnResult } from "../harness-run-turn";
import { KNOWLEDGE_OUTPUT_SCHEMA, type KnowledgeSnapshotContext } from "./mint";
import type { PartitionSlice } from "./partition";
import {
  KNOWLEDGE_SWARM_GENERATOR_ID,
  MAP_VERIFY_OUTPUT_SCHEMA,
  PARTITION_WORKER_OUTPUT_SCHEMA,
  runMapVerify,
  runPartitionWorker,
} from "./swarm";

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
  it("caps only worker hypotheses and invalidates prior worker answers", async () => {
    expect(PARTITION_WORKER_OUTPUT_SCHEMA.properties.statements).toHaveProperty("maxItems", 8);
    expect(KNOWLEDGE_OUTPUT_SCHEMA.properties.statements).not.toHaveProperty("maxItems");
    expect(MAP_VERIFY_OUTPUT_SCHEMA.properties.crossCutting).not.toHaveProperty("maxItems");
    expect(KNOWLEDGE_SWARM_GENERATOR_ID).toBe("knowledge-swarm@4");
    expect(
      PARTITION_WORKER_OUTPUT_SCHEMA.properties.statements.items.properties.hint,
    ).toMatchObject({
      type: "object",
      required: ["path", "coupling"],
      additionalProperties: false,
    });

    const packet = await packetFor(SLICE);
    expect(packet).toContain("Emit at most 8");
    expect(packet).toContain("highest-signal");
    expect(packet).toContain("repo-relative path outside your slice");
    expect(packet).toContain("unresolved coupling");
  });

  it("keeps one actionable off-slice hint in the envelope only", async () => {
    const result = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: [
            rawStatement({
              hint: {
                path: "lib/c.ts",
                coupling: "the source adapter may share this dispatch contract",
              },
            }),
          ],
        }),
    });
    expect(result.status).toBe("ok");
    expect(result.statements).toHaveLength(1);
    const entry = result.statements[0];
    expect(entry?.hint).toEqual({
      path: "lib/c.ts",
      coupling: "the source adapter may share this dispatch contract",
    });
    // The statement itself is hypothesis-labelled, blobOid-anchored, and hint-free.
    expect(entry?.statement.status).toBe("hypothesis");
    expect(entry?.statement.evidence[0]?.blobOid).toBe("blob-a");
    expect(JSON.stringify(entry?.statement)).not.toContain("hint");
  });

  it("drops hints without an off-slice inventory path or an explained coupling", async () => {
    const result = await runPartitionWorker({
      slice: SLICE,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: [
            rawStatement({ hint: { path: "src/b.ts", coupling: "local, not cross-slice" } }),
            rawStatement({
              claim: "another anchored claim",
              hint: { path: "ghost.ts", coupling: "not in the inventory" },
            }),
            rawStatement({
              claim: "a third anchored claim",
              hint: { path: "lib/c.ts", coupling: "   " },
            }),
            rawStatement({
              claim: "a fourth anchored claim",
              hint: { path: "lib/c.ts", coupling: "real words", speculation: true },
            }),
          ],
        }),
    });

    expect(result.statements).toHaveLength(4);
    expect(result.statements.every((entry) => entry.hint === undefined)).toBe(true);
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

  // ── The worker PACKET (W3, Stage 2): skeleton, edges, neighbours ───────────

  /** Run one worker purely to capture the prompt it was handed. */
  async function packetFor(slice: PartitionSlice): Promise<string> {
    let captured = "";
    await runPartitionWorker({
      slice,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async (prompt) => {
        captured = prompt;
        return emitted({ statements: [] });
      },
    });
    return captured;
  }

  it("hands a module batch its skeleton, its own edges, and the edges batching cut", async () => {
    const packet = await packetFor({
      id: "mod:src/a.ts#deadbeef",
      files: [
        {
          path: "src/a.ts",
          blobOid: "blob-a",
          symbols: [
            { name: "runPass", kind: "function", line: 12 },
            { name: "PassOptions", kind: "interface", line: 4 },
          ],
        },
        {
          path: "src/b.ts",
          blobOid: "blob-b",
          symbols: [{ name: "wire", kind: "const", line: 7 }],
        },
      ],
      neighbors: [
        {
          path: "src/b.ts",
          neighbors: [{ path: "lib/c.ts", direction: "imports", symbols: ["helper", "other"] }],
          truncated: 3,
        },
      ],
      imports: [{ from: "src/a.ts", to: "src/b.ts" }],
    });

    // The skeleton: names, kinds and lines, per file.
    expect(packet).toContain("runPass (function) L12");
    expect(packet).toContain("PassOptions (interface) L4");
    expect(packet).toContain("wire (const) L7");
    // The batch's own resolved edges.
    expect(packet).toContain("IMPORTS WITHIN THIS SLICE (1 resolved edges)");
    expect(packet).toContain("src/a.ts -> src/b.ts");
    // The cut edges, with direction, the neighbour's exports, and the truncation.
    expect(packet).toContain("imports lib/c.ts [exports: helper, other]");
    expect(packet).toContain("(+3 more, not shown)");
    // Reading is invited, not forbidden.
    expect(packet).toContain("FREE to read any of it");
  });

  it("gives a fallback slice an honest reduced packet: no skeleton is not an empty skeleton", async () => {
    const packet = await packetFor({
      id: "dir:docs",
      files: [
        // Indexed by the v5 shard family, declares nothing — a real fact.
        { path: "src/a.ts", blobOid: "blob-a", symbols: [] },
        // No shard covers this blob at all — a DIFFERENT fact.
        { path: "src/b.ts", blobOid: "blob-b" },
      ],
      neighbors: [],
      imports: [],
    });
    expect(packet).toContain("src/a.ts\n    (indexed; declares no top-level symbols)");
    expect(packet).toContain("src/b.ts\n    (no symbol index for this file)");
    expect(packet).toContain("IMPORTS WITHIN THIS SLICE: none.");
    expect(packet).toContain("NEIGHBOURS OUTSIDE THIS SLICE: none recorded.");
    // Nothing is fabricated: no edge arrow and no exports list appear anywhere.
    expect(packet).not.toContain(" -> ");
    expect(packet).not.toContain("[exports:");
  });

  it("says the graph was UNREADABLE rather than claiming the slice has no edges", async () => {
    // The degradation path leaves `imports` absent. Reporting that as "none" would
    // tell a worker the files are unconnected when nothing ever looked.
    const packet = await packetFor({ id: "dir:docs", files: SLICE.files, neighbors: [] });
    expect(packet).toContain("the import graph could not be read");
    expect(packet).toContain("Absence below is not evidence of absence");
    expect(packet).not.toContain("IMPORTS WITHIN THIS SLICE: none.");
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

// ─────────────────────────────────────────────────────────────────────────────
// The verify seat since W3 sees only the deterministic merge's RESIDUE: the
// cross-batch seams and the flagged contradictions. So a fixture that wants the
// seat to see a statement has to put that statement on a SEAM — a cut import
// edge whose other end another slice also made claims about. That is not test
// scaffolding around a behaviour change, it IS the behaviour change: a fixture
// with one slice and no cut edge has nothing for the seat to synthesize, and
// under the old shape it still burned a turn re-reading everything.
// ─────────────────────────────────────────────────────────────────────────────

/** Two slices joined by one cut edge: `src/a.ts` ↔ `lib/c.ts`. */
const SLICE_A: PartitionSlice = {
  id: "mod:src/a.ts#aaaa1111",
  files: [
    { path: "src/a.ts", blobOid: "blob-a" },
    { path: "src/b.ts", blobOid: "blob-b" },
  ],
  neighbors: [
    {
      path: "src/a.ts",
      neighbors: [{ path: "lib/c.ts", direction: "imports", symbols: ["helper"] }],
      truncated: 0,
    },
  ],
  imports: [],
};

const SLICE_B: PartitionSlice = {
  id: "mod:lib/c.ts#bbbb2222",
  files: [{ path: "lib/c.ts", blobOid: "blob-c" }],
  neighbors: [
    {
      path: "lib/c.ts",
      neighbors: [{ path: "src/a.ts", direction: "imported-by", symbols: ["a"] }],
      truncated: 0,
    },
  ],
  imports: [],
};

const SEAM_SLICES = [SLICE_A, SLICE_B];

/** A worker over `slice` emitting exactly the raw statements given. */
function mintOver(slice: PartitionSlice, statements: Record<string, unknown>[]) {
  return runPartitionWorker({
    slice,
    snapshot: SNAPSHOT,
    provenance: PROVENANCE,
    runTurn: async () => emitted({ statements }),
  });
}

/** The far side of the seam: one claim anchored in `lib/c.ts`, from the other slice. */
function farSide() {
  return mintOver(SLICE_B, [
    {
      ...rawStatement(),
      subject: "lib",
      claim: "c is the helper",
      evidence: [{ path: "lib/c.ts" }],
    },
  ]);
}

describe("runMapVerify", () => {
  async function workerResults() {
    const near = await mintOver(SLICE_A, [
      rawStatement({
        hint: {
          path: "lib/c.ts",
          coupling: "the helper may share the source dispatch contract",
        },
      }),
      rawStatement({ claim: "b wires the adapters", evidence: [{ path: "src/b.ts" }] }),
    ]);
    return [near, await farSide()];
  }

  it("accepts verdicts only for flagged statements, never seam-group leads", async () => {
    const results = await workerResults();
    const [first, second] = results[0]?.statements ?? [];
    const prior = (await mintOver(SLICE_A, [rawStatement({ claim: "an older claim" })]))
      .statements[0]?.statement;
    const verify = await runMapVerify({
      workerResults: results,
      slices: SEAM_SLICES,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      reverify: prior === undefined ? [] : [prior],
      runTurn: async () =>
        emitted({
          verdicts: [
            { id: first?.statement.id, verdict: "rejected" },
            { id: prior?.id, verdict: "confirmed" },
            { id: "no-such-id", verdict: "rejected" }, // unknown id ⇒ ignored
          ],
          crossCutting: [],
        }),
    });
    expect(verify.status).toBe("ok");
    expect(verify.confirmed).toBe(1);
    expect(verify.rejected).toBe(0);
    const byId = new Map(verify.set?.statements.map((s) => [s.id, s.status]));
    expect(byId.get(first?.statement.id ?? "")).toBe("hypothesis");
    expect(byId.get(second?.statement.id ?? "")).toBe("hypothesis");
    expect(byId.get(prior?.id ?? "")).toBe("confirmed");
  });

  it("renders a non-lead hint source while adjudicating a seam lead only in its flag chunk", async () => {
    const near = await mintOver(SLICE_A, [
      rawStatement({
        claim: "src/a.ts imports src/b.ts",
        evidence: [{ path: "src/a.ts" }],
      }),
      rawStatement({
        claim: "b carries the shared dispatch key",
        evidence: [{ path: "src/b.ts" }],
        hint: {
          path: "lib/c.ts",
          coupling: "the helper may consume the same dispatch key",
        },
      }),
    ]);
    const target = near.statements[0]?.statement;
    expect(target).toBeDefined();

    const prompts: string[] = [];
    const verify = await runMapVerify({
      workerResults: [near, await farSide()],
      slices: SEAM_SLICES,
      importEdges: [{ from: "src/a.ts", to: "lib/c.ts" }],
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      chunkSize: 1,
      concurrency: 1,
      runTurn: async (prompt) => {
        prompts.push(prompt);
        const flagChunk = !prompt.includes("FLAGGED STATEMENTS:\n(none)");
        return emitted({
          verdicts: [
            {
              id: target?.id,
              verdict: flagChunk ? "confirmed" : "rejected",
            },
          ],
          crossCutting: [],
        });
      },
    });

    expect(verify.status).toBe("ok");
    expect(verify.confirmed).toBe(1);
    expect(verify.rejected).toBe(0);
    expect(verify.set?.statements.find((statement) => statement.id === target?.id)?.status).toBe(
      "confirmed",
    );
    expect(prompts.filter((prompt) => prompt.includes(target?.id ?? ""))).toHaveLength(2);

    const sourceGroupPrompt = prompts.find((prompt) =>
      prompt.includes(`source slice=${SLICE_A.id}`),
    );
    expect(sourceGroupPrompt).toContain("src/a.ts imports src/b.ts");
    expect(sourceGroupPrompt).toContain("b carries the shared dispatch key");
    expect(sourceGroupPrompt).toContain("evidence: src/b.ts");
    expect(sourceGroupPrompt).toContain("off-slice hint: lib/c.ts");
    expect(sourceGroupPrompt).toContain("the helper may consume the same dispatch key");
    expect(JSON.stringify(verify.set)).not.toContain(
      "the helper may consume the same dispatch key",
    );
  });

  it("sends the seat the SEAMS only — a settled statement never reaches it", async () => {
    // `src/b.ts` sits on no cut edge, so its claim is settled by the merge and is
    // not re-adjudicated. It is still in the set: dropped from the PROMPT, not
    // from the map.
    const results = await workerResults();
    const settled = results[0]?.statements[1]?.statement;
    let prompt = "";
    const verify = await runMapVerify({
      workerResults: results,
      slices: SEAM_SLICES,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async (text) => {
        prompt = text;
        return emitted({ verdicts: [], crossCutting: [] });
      },
    });
    expect(prompt).not.toContain("b wires the adapters");
    expect(prompt).toContain("src holds the sources"); // the seam statement
    expect(verify.set?.statements.map((s) => s.id)).toContain(settled?.id);
    // …and the measurement the redesign exists to move.
    expect(verify.merged).toBe(3);
    expect(verify.residue).toBe(2);
  });

  it("runs NO turn at all when the residue is empty", async () => {
    // One slice, no cut edge, no contradiction: nothing for a seat to do. The old
    // shape still spent a turn here, over a prompt carrying every hypothesis.
    let turns = 0;
    const worker = await mintOver(SLICE_A, [rawStatement()]);
    const verify = await runMapVerify({
      workerResults: [worker],
      slices: [SLICE_A],
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      runTurn: async () => {
        turns += 1;
        return emitted({ verdicts: [], crossCutting: [] });
      },
    });
    expect(turns).toBe(0);
    expect(verify.status).toBe("ok");
    expect(verify.residue).toBe(0);
    expect(verify.crossCutting).toBe(0);
    // The worker's statement survives; it was settled, not discarded.
    expect(verify.set?.statements).toHaveLength(1);
  });

  it("mints anchored cross-cutting statements as hypotheses and discards hints from the set", async () => {
    const results = await workerResults();
    const verify = await runMapVerify({
      workerResults: results,
      slices: SEAM_SLICES,
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
    expect(JSON.stringify(verify.set)).not.toContain("the helper may share");
    expect(verify.droppedStatements).toBe(1);
  });

  it("chunks by seam groups while keeping every source slice in exactly one prompt", async () => {
    const files = [
      ...Array.from({ length: 7 }, (_, index) => ({
        path: `src/s${index}.ts`,
        blobOid: `blob-s${index}`,
      })),
      { path: "lib/target.ts", blobOid: "blob-target" },
    ];
    const snapshot: KnowledgeSnapshotContext = { ...SNAPSHOT, files };
    const slices: PartitionSlice[] = files.slice(0, 7).map((file, index) => ({
      id: `slice-${index}`,
      files: [file],
      neighbors: [],
    }));
    const workers = await Promise.all(
      slices.map((slice, index) =>
        runPartitionWorker({
          slice,
          snapshot,
          provenance: PROVENANCE,
          runTurn: async () =>
            emitted({
              statements: [
                rawStatement({
                  subject: slice.id,
                  claim: `claim number ${index}`,
                  evidence: [{ path: slice.files[0]?.path }],
                  hint: {
                    path: "lib/target.ts",
                    coupling: `target may share contract ${index}`,
                  },
                }),
              ],
            }),
        }),
      ),
    );
    const ids = workers.flatMap((worker) => worker.statements.map((entry) => entry.statement.id));
    expect(new Set(ids).size).toBe(7);

    const prompts: string[] = [];
    const verify = await runMapVerify({
      workerResults: workers,
      slices,
      snapshot,
      provenance: PROVENANCE,
      chunkSize: 3,
      runTurn: async (prompt) => {
        prompts.push(prompt);
        return emitted({
          verdicts: ids
            .filter((id) => prompt.includes(id))
            .map((id) => ({ id, verdict: "confirmed" })),
          crossCutting: [],
        });
      },
    });

    expect(verify.residue).toBe(7);
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(ids.filter((id) => prompt.includes(id)).length).toBeLessThanOrEqual(3);
    }
    // Every group lead appears in exactly one prompt. Its unsolicited verdict is
    // ignored because seam groups are synthesis-only.
    expect(prompts.flatMap((prompt) => ids.filter((id) => prompt.includes(id))).sort()).toEqual(
      [...ids].sort(),
    );
    expect(verify.status).toBe("ok");
    expect(verify.confirmed).toBe(0);
    expect(verify.set?.statements.every((statement) => statement.status === "hypothesis")).toBe(
      true,
    );
  });

  it("a single failed chunk fails the whole pass (never a partial verify)", async () => {
    const near = await mintOver(
      SLICE_A,
      Array.from({ length: 4 }, (_, index) => rawStatement({ claim: `claim number ${index}` })),
    );
    let turn = 0;
    const verify = await runMapVerify({
      workerResults: [near, await farSide()],
      slices: SEAM_SLICES,
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
    // …and the chunks still queued behind it never ran: the pass is all-or-nothing,
    // so once one chunk fails every later turn is spend on a decided verdict.
    expect(turn).toBe(2);
  });

  it("dedups stored statements while repeated results for one slice still make one group", async () => {
    const duplicate = rawStatement();
    const first = await mintOver(SLICE_A, [
      duplicate,
      rawStatement({ claim: "x one" }),
      rawStatement({ claim: "x two" }),
    ]);
    const second = await mintOver(SLICE_A, [
      rawStatement({ claim: "y one" }),
      rawStatement({ claim: "y two" }),
      duplicate,
    ]);
    const duplicateId = first.statements[0]?.statement.id;
    expect(duplicateId).toBe(second.statements[2]?.statement.id);

    const prompts: string[] = [];
    let turn = 0;
    const verify = await runMapVerify({
      workerResults: [first, second, await farSide()],
      slices: SEAM_SLICES,
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      chunkSize: 3,
      concurrency: 1,
      runTurn: async (prompt) => {
        prompts.push(prompt);
        turn += 1;
        const verdict = turn === 1 ? "confirmed" : "rejected";
        const ids = [...prompt.matchAll(/^- id=(\S+)$/gm)].map(([, id]) => id);
        return emitted({ verdicts: ids.map((id) => ({ id, verdict })), crossCutting: [] });
      },
    });

    expect(verify.duplicateIds).toBe(1);
    expect(
      prompts.reduce(
        (count, prompt) => count + prompt.split(`source slice=${SLICE_A.id}`).length - 1,
        0,
      ),
    ).toBe(1);
    expect(verify.status).toBe("ok");
    expect(verify.set?.statements).toHaveLength(6); // 5 distinct near-side + 1 far-side
    expect(verify.set?.statements.find((s) => s.id === duplicateId)?.status).toBe("hypothesis");
    expect(verify.confirmed + verify.rejected).toBe(0);
  });

  it("runs a bounded cross-boundary pass over the chunks' own cross-cutting output", async () => {
    // Chunking cost the seat any pattern whose halves landed in different turns.
    // The second pass reads the chunks' OUTPUTS — never their hypotheses — so it
    // can see across the boundary without rebuilding the prompt that overflowed.
    const near = await mintOver(
      SLICE_A,
      Array.from({ length: 3 }, (_, index) => rawStatement({ claim: `claim number ${index}` })),
    );
    const hintSlice: PartitionSlice = {
      id: "hint:docs/e.md",
      files: [{ path: "docs/e.md", blobOid: "blob-e" }],
      neighbors: [],
    };
    const snapshot: KnowledgeSnapshotContext = {
      ...SNAPSHOT,
      files: [...SNAPSHOT.files, ...hintSlice.files],
    };
    const hinted = await runPartitionWorker({
      slice: hintSlice,
      snapshot,
      provenance: PROVENANCE,
      runTurn: async () =>
        emitted({
          statements: [
            rawStatement({
              subject: "docs",
              claim: "e documents the shared contract",
              evidence: [{ path: "docs/e.md" }],
              hint: { path: "lib/c.ts", coupling: "the helper implements the documented contract" },
            }),
          ],
        }),
    });
    const prompts: string[] = [];
    let turn = 0;
    const verify = await runMapVerify({
      workerResults: [near, await farSide(), hinted],
      slices: [...SEAM_SLICES, hintSlice],
      snapshot,
      provenance: PROVENANCE,
      chunkSize: 2,
      concurrency: 1,
      runTurn: async (prompt) => {
        prompts.push(prompt);
        turn += 1;
        const crossCutting =
          turn === 1
            ? [
                rawStatement({ claim: "chunk-local primary 1" }),
                rawStatement({ claim: "chunk-local secondary 1" }),
              ]
            : turn === 2
              ? [rawStatement({ claim: "chunk-local primary 2" })]
              : [rawStatement({ claim: "cross-boundary pattern" })];
        return emitted({
          verdicts: [],
          crossCutting,
        });
      },
    });

    // Three source-slice groups across two turns, then one synthesis turn.
    expect(verify.residue).toBe(3);
    expect(prompts).toHaveLength(3);
    const boundary = prompts[2] ?? "";
    expect(boundary).toContain("CROSS-BOUNDARY");
    expect(boundary).toContain("chunk-local primary 1");
    expect(boundary).toContain("chunk-local primary 2");
    expect(boundary).not.toContain("chunk-local secondary 1");
    // Bounded: it carries a digest LINE per chunk, not the chunks' hypotheses.
    expect(boundary).toContain("chunk 1: 2 residue work items");
    expect(boundary).toContain("chunk 2: 1 residue work item");
    for (const entry of near.statements) {
      expect(boundary).not.toContain(entry.statement.claim);
    }
    // Its mint lands in the set beside the chunk-local ones.
    expect(verify.status).toBe("ok");
    expect(verify.crossCutting).toBe(4);
    const claims = verify.set?.statements.map((s) => s.claim) ?? [];
    expect(claims).toContain("chunk-local secondary 1");
    expect(claims).toContain("cross-boundary pattern");
  });

  it("skips the cross-boundary pass when one chunk already saw everything", async () => {
    let turns = 0;
    const verify = await runMapVerify({
      workerResults: [await mintOver(SLICE_A, [rawStatement()]), await farSide()],
      slices: SEAM_SLICES,
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
    const near = await mintOver(SLICE_A, [
      rawStatement(),
      rawStatement({ claim: "second claim" }),
      rawStatement({ claim: "third claim" }),
    ]);
    let turn = 0;
    const verify = await runMapVerify({
      workerResults: [near, await farSide()],
      slices: SEAM_SLICES,
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
    // Both residue chunks succeeded; only the bonus synthesis turn died.
    expect(turn).toBe(3);
    expect(verify.status).toBe("ok");
    expect(verify.crossCutting).toBe(2);
  });

  it("routes a delta's changed-evidence statements to the seat as flagged", async () => {
    const near = await mintOver(SLICE_A, [rawStatement()]);
    const prior = (await mintOver(SLICE_A, [rawStatement({ claim: "an older claim" })]))
      .statements[0]?.statement;
    let prompt = "";
    const verify = await runMapVerify({
      workerResults: [near],
      slices: [SLICE_A],
      snapshot: SNAPSHOT,
      provenance: PROVENANCE,
      reverify: prior === undefined ? [] : [prior],
      runTurn: async (text) => {
        prompt = text;
        return emitted({ verdicts: [{ id: prior?.id, verdict: "confirmed" }], crossCutting: [] });
      },
    });
    // The seam-less near-side statement is settled; only the prior one is judged.
    expect(verify.residue).toBe(1);
    expect(prompt).toContain("FLAGGED: a prior statement whose cited evidence changed");
    expect(prompt).not.toContain("src holds the sources");
    expect(verify.confirmed).toBe(1);
    expect(verify.set?.statements.find((s) => s.id === prior?.id)?.status).toBe("confirmed");
  });

  it("dedups by statement id across workers and cross-cutting re-mints", async () => {
    const results = await workerResults();
    const duplicate = results[0]?.statements[0]?.statement;
    const verify = await runMapVerify({
      workerResults: [...results, ...results], // same worker results twice ⇒ duplicate ids
      slices: SEAM_SLICES,
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
