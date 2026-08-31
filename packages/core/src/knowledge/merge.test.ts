import type { KnowledgeAnchor, KnowledgeStatement } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { mergeWorkerResults } from "./merge";
import type { KnowledgeSnapshotContext } from "./mint";
import { NEIGHBOR_CAP, type PartitionSlice } from "./partition";
import { knowledgeStatementId } from "./read";
import type { PartitionWorkerResult, WorkerCrossSliceHint, WorkerStatement } from "./swarm";

const SNAPSHOT: KnowledgeSnapshotContext = {
  repoKey: "repo",
  baseOid: "a".repeat(40),
  snapshotFingerprint: "fp-1",
  files: [
    { path: "src/a.ts", blobOid: "blob-a" },
    { path: "src/b.ts", blobOid: "blob-b" },
    { path: "lib/c.ts", blobOid: "blob-c" },
    { path: "lib/d.ts", blobOid: "blob-d" },
  ],
  scopes: [],
};

const SLICE_A: PartitionSlice = {
  id: "mod:src/a.ts#aaaa",
  files: [
    { path: "src/a.ts", blobOid: "blob-a" },
    { path: "src/b.ts", blobOid: "blob-b" },
  ],
  // `src/a.ts` sits on a cut edge to `lib/c.ts`; `src/b.ts` sits on none.
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
  id: "mod:lib/c.ts#bbbb",
  files: [
    { path: "lib/c.ts", blobOid: "blob-c" },
    { path: "lib/d.ts", blobOid: "blob-d" },
  ],
  neighbors: [
    {
      path: "lib/c.ts",
      neighbors: [{ path: "src/a.ts", direction: "imported-by", symbols: ["a"] }],
      truncated: 0,
    },
  ],
  imports: [],
};

const SLICES = [SLICE_A, SLICE_B];

const BLOBS = new Map(SNAPSHOT.files.map((file) => [file.path, file.blobOid]));

function anchors(paths: readonly (string | [string, number])[]): KnowledgeAnchor[] {
  return paths.map((entry) => {
    const [path, startLine] = Array.isArray(entry) ? entry : ([entry, undefined] as const);
    return {
      path,
      blobOid: BLOBS.get(path) ?? "unknown",
      ...(startLine === undefined ? {} : { lines: { startLine } }),
    };
  });
}

function statement(input: {
  subject?: string;
  claim: string;
  evidence: readonly (string | [string, number])[];
}): KnowledgeStatement {
  const subject = input.subject ?? "src";
  const evidence = anchors(input.evidence);
  return {
    id: knowledgeStatementId({ subject, aspect: "purpose", claim: input.claim, evidence }),
    subject,
    aspect: "purpose",
    claim: input.claim,
    evidence,
    confidence: "high",
    status: "hypothesis",
    provenance: { generator: "knowledge-swarm@1", model: "worker-model", apiKeySource: null },
    learnedAgainst: {
      baseOid: SNAPSHOT.baseOid,
      snapshotFingerprint: SNAPSHOT.snapshotFingerprint,
    },
  };
}

function worker(sliceId: string, entries: readonly WorkerStatement[]): PartitionWorkerResult {
  return {
    sliceId,
    status: "ok",
    statements: entries,
    droppedAnchors: 0,
    droppedStatements: 0,
    attempts: 1,
  };
}

const wrap = (s: KnowledgeStatement, hint?: WorkerCrossSliceHint): WorkerStatement =>
  hint === undefined ? { statement: s } : { statement: s, hint };

describe("mergeWorkerResults — the deterministic half", () => {
  it("collapses duplicate ids, and leaves distinct claims alone", () => {
    const duplicate = statement({ claim: "a is the entry", evidence: ["src/a.ts"] });
    const other = statement({ claim: "b is the wiring", evidence: ["src/b.ts"] });
    const merged = mergeWorkerResults({
      workerResults: [
        worker(SLICE_A.id, [wrap(duplicate), wrap(other)]),
        worker(SLICE_B.id, [wrap(duplicate)]),
      ],
      slices: SLICES,
      snapshot: SNAPSHOT,
    });
    expect(merged.duplicateIds).toBe(1);
    expect(merged.statements).toHaveLength(2);
    // The control: the two DISTINCT claims both survive, so the collapse is not
    // simply "keep one statement".
    expect(merged.statements.map((s) => s.claim).sort()).toEqual([
      "a is the entry",
      "b is the wiring",
    ]);
  });

  it("keeps the BETTER-ANCHORED of two identical claims, whatever order they arrive in", () => {
    const thin = statement({ claim: "a is the entry", evidence: ["src/a.ts"] });
    const thick = statement({ claim: "a is the entry", evidence: ["src/a.ts", "src/b.ts"] });
    expect(thin.id).not.toBe(thick.id); // same claim, different evidence ⇒ different id

    for (const order of [
      [thin, thick],
      [thick, thin],
    ]) {
      const merged = mergeWorkerResults({
        workerResults: [
          worker(SLICE_A.id, [wrap(order[0] as KnowledgeStatement)]),
          worker(SLICE_B.id, [wrap(order[1] as KnowledgeStatement)]),
        ],
        slices: SLICES,
        snapshot: SNAPSHOT,
      });
      expect(merged.duplicateClaims).toBe(1);
      expect(merged.statements).toHaveLength(1);
      expect(merged.statements[0]?.id).toBe(thick.id);
    }
  });

  it("breaks an anchor-count tie by line spans, from EITHER side of the comparison", () => {
    // Both assignments, because the tiebreak is a two-argument comparison and a
    // version that just kept whichever it was already holding passes one of them.
    //
    // The two anchor DIFFERENT files, deliberately: `knowledgeStatementId` does not
    // hash line spans, so a pair differing only by a span shares one id and is
    // collapsed as a duplicate id long before this tiebreak is reached.
    //
    // WHICH files matters, and the assertion below is the fixture's load-bearing
    // half. The id tiebreak (smaller id wins) runs immediately after the span rule,
    // so a fixture where the two rules AGREE cannot tell them apart: deleting the
    // span branch entirely would still elect `spanned`, and this test would stay
    // green over a merge that had lost the rule it is named for. So the paths are
    // chosen to make the id rule pick the WRONG one, and that requirement is
    // asserted here rather than left as a comment for the next reader to re-derive.
    const spanless = statement({ claim: "the pattern holds", evidence: ["src/a.ts"] });
    const spanned = statement({ claim: "the pattern holds", evidence: [["src/b.ts", 10]] });
    expect(spanless.id).not.toBe(spanned.id);
    expect(spanless.id < spanned.id).toBe(true);
    for (const [first, second] of [
      [spanless, spanned],
      [spanned, spanless],
    ] as const) {
      const merged = mergeWorkerResults({
        // Distinct slice ids, and the merge iterates slices in id order, so this
        // fixes which of the two is `held` when the comparison runs.
        workerResults: [worker("slice:1", [wrap(first)]), worker("slice:2", [wrap(second)])],
        slices: SLICES,
        snapshot: SNAPSHOT,
      });
      expect(merged.statements).toHaveLength(1);
      expect(merged.statements[0]?.id).toBe(spanned.id);
    }
  });

  it("keeps the WORKER's provenance byte for byte — the merge never re-mints", () => {
    const kept = statement({ claim: "a is the entry", evidence: ["src/a.ts"] });
    const merged = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(kept)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
    });
    expect(merged.statements[0]).toBe(kept);
  });

  // ── The authoritative edge shard ───────────────────────────────────────────

  const importEdges = [{ from: "src/a.ts", to: "lib/c.ts" }];

  it("flags an import-shaped claim the edge shard contradicts", () => {
    const wrong = statement({
      claim: "src/b.ts imports lib/d.ts to reach the store",
      evidence: ["src/b.ts"],
    });
    const merged = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(wrong)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
      importEdges,
    });
    expect(merged.flagged.map((f) => f.statement.id)).toEqual([wrong.id]);
    expect(merged.flagged[0]?.reason).toContain("no resolved import edge");
    // FLAGGED, not deleted: the index is textual and a computed import looks the
    // same, so the claim stays in the set for a seat to judge.
    expect(merged.statements.map((s) => s.id)).toContain(wrong.id);
  });

  it("does NOT flag the same shape when an edge really joins the files", () => {
    const right = statement({
      claim: "src/a.ts imports lib/c.ts for the helper",
      evidence: ["src/a.ts"],
    });
    const merged = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(right)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
      importEdges,
    });
    expect(merged.flagged).toEqual([]);
  });

  it("does NOT flag a claim that names two files without asserting an import", () => {
    // "uses" is a real relationship the import graph has no opinion about.
    const vague = statement({
      claim: "src/b.ts and lib/d.ts use the same naming convention",
      evidence: ["src/b.ts"],
    });
    const merged = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(vague)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
      importEdges,
    });
    expect(merged.flagged).toEqual([]);
  });

  it("flags nothing when the import graph could not be read", () => {
    // A graph nothing could read contradicts nothing. Reporting the same claim as
    // contradicted here would send a seat to adjudicate an absence of evidence.
    const wrong = statement({
      claim: "src/b.ts imports lib/d.ts to reach the store",
      evidence: ["src/b.ts"],
    });
    const merged = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(wrong)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
    });
    expect(merged.flagged).toEqual([]);
  });

  it("flags an import assertion whose SECOND endpoint is cited rather than named", () => {
    // The shape a worker actually emits: one end written down, the other end sitting
    // in the evidence. Reading only the prose left this unchecked.
    const cited = statement({
      subject: "src/b.ts",
      claim: "this module imports the store to persist a review",
      evidence: ["src/b.ts", "lib/d.ts"],
    });
    const merged = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(cited)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
      importEdges,
    });
    expect(merged.flagged.map((f) => f.statement.id)).toEqual([cited.id]);
    // The endpoints are named in the reason, so the seat is told which pair the
    // shard could not join rather than being sent to re-derive it.
    expect(merged.flagged[0]?.reason).toContain("(lib/d.ts, src/b.ts)");
  });

  it("leaves an import assertion with only ONE resolvable endpoint as a hypothesis", () => {
    // The stated ceiling: "the persistence layer" is not a path, so there is no
    // second endpoint to cross-check and nothing a seat could adjudicate either.
    // Guessing one would flood the residue with unanswerable questions.
    const unresolvable = statement({
      subject: "src",
      claim: "src/b.ts imports the persistence layer at startup",
      evidence: ["src/b.ts"],
    });
    const merged = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(unresolvable)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
      importEdges,
    });
    expect(merged.flagged).toEqual([]);
    expect(merged.statements.map((s) => s.id)).toEqual([unresolvable.id]);
  });

  it("routes a delta's changed-evidence statements straight to the flagged pile", () => {
    const prior = statement({ claim: "an older claim", evidence: ["lib/d.ts"] });
    const merged = mergeWorkerResults({
      workerResults: [],
      slices: SLICES,
      snapshot: SNAPSHOT,
      reverify: [prior],
    });
    expect(merged.flagged.map((f) => f.statement.id)).toEqual([prior.id]);
    expect(merged.flagged[0]?.reason).toContain("cited evidence changed");
    expect(merged.statements.map((s) => s.id)).toEqual([prior.id]);
  });

  it("a FRESH worker mint supersedes the reverify entry carrying the same id", () => {
    // Same id means same claim over the same anchors at the same blobOids — a worker
    // just re-read those bytes and said it again. The prior used to be appended past
    // the id map, so the set carried two copies of one claim and the seat got a
    // residue entry about evidence that had not moved after all.
    const prior = statement({ claim: "a is the entry", evidence: ["src/a.ts"] });
    const fresh: KnowledgeStatement = {
      ...prior,
      provenance: { ...prior.provenance, model: "fresh-worker" },
    };
    expect(fresh.id).toBe(prior.id);

    const merged = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(fresh)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
      reverify: [prior],
    });
    expect(merged.statements).toHaveLength(1);
    // The FRESH one, provenance and all — asserted by identity, so a version that
    // kept the prior's object cannot pass on id equality alone.
    expect(merged.statements[0]).toBe(fresh);
    expect(merged.flagged).toEqual([]);
  });

  // ── Seams ─────────────────────────────────────────────────────────────────

  it("groups every active cut endpoint per source slice around its highest-ranked statement", () => {
    const highestRanked = statement({ claim: "b is the local entry", evidence: ["src/b.ts"] });
    const twoClaimsOnOneEdge = [
      statement({ claim: "a owns retries", evidence: ["src/a.ts"] }),
      statement({ claim: "a owns dispatch", evidence: ["src/a.ts"] }),
    ];
    const farClaims = [
      statement({ subject: "lib", claim: "c receives dispatch", evidence: ["lib/c.ts"] }),
      statement({ subject: "lib", claim: "d records dispatch", evidence: ["lib/d.ts"] }),
    ];
    const merged = mergeWorkerResults({
      workerResults: [
        worker(SLICE_A.id, [
          wrap(highestRanked),
          ...twoClaimsOnOneEdge.map((entry) => wrap(entry)),
        ]),
        worker(
          SLICE_B.id,
          farClaims.map((entry) => wrap(entry)),
        ),
      ],
      slices: SLICES,
      snapshot: SNAPSHOT,
      importEdges: [
        { from: "src/a.ts", to: "lib/c.ts" },
        { from: "src/a.ts", to: "lib/d.ts" },
      ],
    });

    const source = merged.seamGroups.find((group) => group.sourceSliceId === SLICE_A.id);
    expect(source?.leadStatement).toBe(highestRanked);
    expect(source?.cutEdges).toEqual([
      { localPath: "src/a.ts", offSlicePath: "lib/c.ts" },
      { localPath: "src/a.ts", offSlicePath: "lib/d.ts" },
    ]);
    expect(merged.seamGroups).toHaveLength(2);
  });

  it("makes a claim a seam only when the cut edge's OTHER END is also claimed", () => {
    const onSeam = statement({ claim: "a is the entry", evidence: ["src/a.ts"] });
    const offSeam = statement({ claim: "b is the wiring", evidence: ["src/b.ts"] });
    const farSide = statement({ subject: "lib", claim: "c helps", evidence: ["lib/c.ts"] });

    const withFarSide = mergeWorkerResults({
      workerResults: [
        worker(SLICE_A.id, [wrap(onSeam), wrap(offSeam)]),
        worker(SLICE_B.id, [wrap(farSide)]),
      ],
      slices: SLICES,
      snapshot: SNAPSHOT,
    });
    expect(withFarSide.seamGroups.map((group) => group.sourceSliceId).sort()).toEqual(
      [SLICE_A.id, SLICE_B.id].sort(),
    );
    expect(
      withFarSide.seamGroups.find((group) => group.sourceSliceId === SLICE_A.id)?.leadStatement,
    ).toBe(onSeam);
    // `src/b.ts` sits on no cut edge, so nothing about it can span two batches.
    expect(withFarSide.seamGroups.map((group) => group.leadStatement.claim)).not.toContain(
      "b is the wiring",
    );

    // The control: remove the far-side claim and the seam disappears. A cut edge
    // alone is not a seam — the other end has to have been written about.
    const withoutFarSide = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(onSeam), wrap(offSeam)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
    });
    expect(withoutFarSide.seamGroups).toEqual([]);
  });

  it("keeps the seam when BOTH ends of a cut edge minted the same claim", () => {
    // The case dedupe deleted. Two workers on opposite ends of one cut edge see the
    // same pattern and word it identically; step 2 collapses them to one
    // representative, and with the collapsed twin went the only proof that the other
    // end of the edge had been written about. The survivor was then neither seam nor
    // flag — the exact pair this pass exists to surface, dropped silently.
    const fromHere = statement({
      claim: "both ends share the retry shape",
      evidence: ["src/a.ts"],
    });
    const fromThere = statement({
      claim: "both ends share the retry shape",
      evidence: ["lib/c.ts"],
    });
    expect(fromHere.id).not.toBe(fromThere.id);

    const merged = mergeWorkerResults({
      workerResults: [worker(SLICE_A.id, [wrap(fromHere)]), worker(SLICE_B.id, [wrap(fromThere)])],
      slices: SLICES,
      snapshot: SNAPSHOT,
    });
    // One claim survives in storage, but both pre-dedupe source slices still reach
    // synthesis with their own local orientation.
    expect(merged.duplicateClaims).toBe(1);
    expect(merged.statements).toHaveLength(1);
    expect(merged.seamGroups.map((group) => group.leadStatement.id).sort()).toEqual(
      [fromHere.id, fromThere.id].sort(),
    );
  });

  it("finds a seam on a cut edge BEYOND the neighbour-map cap", () => {
    // The neighbour map is truncated at NEIGHBOR_CAP for prompt size. A seam read off
    // it inherits that cap, so a hub's later neighbours become invisible to the merge
    // as well as to the packet — and nothing reports the loss.
    const far = Array.from({ length: NEIGHBOR_CAP + 10 }, (_, i) => `lib/n${i}.ts`);
    const beyondCap = far[NEIGHBOR_CAP + 5] as string;
    const hubSlice: PartitionSlice = {
      id: "mod:src/hub.ts#hub00000",
      files: [{ path: "src/hub.ts", blobOid: "blob-hub" }],
      neighbors: [
        {
          path: "src/hub.ts",
          // Exactly what a real packet carries: the cap, plus the count it dropped.
          neighbors: far.slice(0, NEIGHBOR_CAP).map((path) => ({
            path,
            direction: "imports" as const,
            symbols: [],
          })),
          truncated: far.length - NEIGHBOR_CAP,
        },
      ],
      imports: [],
    };
    const farSlice: PartitionSlice = {
      id: "mod:lib/n0.ts#far00000",
      files: far.map((path) => ({ path, blobOid: `blob-${path}` })),
      neighbors: [],
      imports: [],
    };
    const onHub = statement({ claim: "the hub owns the retry loop", evidence: ["src/hub.ts"] });
    const onFar = statement({
      subject: "lib",
      claim: "this one retries too",
      evidence: [beyondCap],
    });
    const input = {
      workerResults: [worker(hubSlice.id, [wrap(onHub)]), worker(farSlice.id, [wrap(onFar)])],
      slices: [hubSlice, farSlice],
      snapshot: SNAPSHOT,
    };

    const merged = mergeWorkerResults({
      ...input,
      importEdges: far.map((to) => ({ from: "src/hub.ts", to })),
    });
    expect(merged.seamGroups.map((group) => group.leadStatement.id).sort()).toEqual(
      [onHub.id, onFar.id].sort(),
    );

    // The control, in-test: withhold the authoritative edges and the same fixture
    // falls back to the capped neighbour map, which cannot see this pair at all.
    expect(mergeWorkerResults(input).seamGroups).toEqual([]);
  });

  it("never treats two claims from ONE slice as a seam", () => {
    // A single worker already saw both, so there is nothing to synthesize across.
    const first = statement({ claim: "a is the entry", evidence: ["src/a.ts"] });
    const second = statement({ subject: "lib", claim: "c helps", evidence: ["lib/c.ts"] });
    const oneSlice: PartitionSlice = {
      ...SLICE_A,
      files: [...SLICE_A.files, { path: "lib/c.ts", blobOid: "blob-c" }],
    };
    const merged = mergeWorkerResults({
      workerResults: [worker(oneSlice.id, [wrap(first), wrap(second)])],
      slices: [oneSlice],
      snapshot: SNAPSHOT,
    });
    expect(merged.seamGroups).toEqual([]);
  });

  it("keeps the chosen hint's local source when it differs from the ranked lead", () => {
    const lead = statement({ claim: "b is the wiring", evidence: ["src/b.ts"] });
    const hintSource = statement({
      claim: "b has an off-slice counterpart",
      evidence: ["src/b.ts"],
    });
    const hint = { path: "lib/d.ts", coupling: "the adapter shares this wire contract" };
    const later = statement({ claim: "b has another lead", evidence: ["src/b.ts"] });
    const merged = mergeWorkerResults({
      workerResults: [
        worker(SLICE_A.id, [
          wrap(lead),
          wrap(hintSource, hint),
          wrap(later, { path: "lib/c.ts", coupling: "a lower-ranked possible coupling" }),
        ]),
      ],
      slices: SLICES,
      snapshot: SNAPSHOT,
    });
    expect(merged.seamGroups).toEqual([
      {
        kind: "hint",
        sourceSliceId: SLICE_A.id,
        leadStatement: lead,
        cutEdges: [],
        hint: { ...hint, sourceStatement: hintSource },
      },
    ]);
  });

  it("is a pure function: shuffled worker order yields an identical result", () => {
    const entries = [
      worker(SLICE_A.id, [
        wrap(statement({ claim: "a is the entry", evidence: ["src/a.ts"] })),
        wrap(statement({ claim: "b is the wiring", evidence: ["src/b.ts"] })),
      ]),
      worker(SLICE_B.id, [
        wrap(statement({ subject: "lib", claim: "c helps", evidence: ["lib/c.ts"] })),
        wrap(statement({ subject: "lib", claim: "d helps too", evidence: ["lib/d.ts"] })),
      ]),
    ];
    const forwards = mergeWorkerResults({
      workerResults: entries,
      slices: SLICES,
      snapshot: SNAPSHOT,
      importEdges,
    });
    const backwards = mergeWorkerResults({
      workerResults: [...entries].reverse(),
      slices: [...SLICES].reverse(),
      snapshot: SNAPSHOT,
      importEdges: [...importEdges].reverse(),
    });
    expect(backwards).toEqual(forwards);
  });

  it("ignores a FAILED worker's result entirely", () => {
    const failed: PartitionWorkerResult = {
      sliceId: SLICE_B.id,
      status: "failed",
      failureReason: "turn exploded",
      statements: [],
      droppedAnchors: 0,
      droppedStatements: 0,
      attempts: 2,
    };
    const merged = mergeWorkerResults({
      workerResults: [
        worker(SLICE_A.id, [wrap(statement({ claim: "a is the entry", evidence: ["src/a.ts"] }))]),
        failed,
      ],
      slices: SLICES,
      snapshot: SNAPSHOT,
    });
    expect(merged.statements).toHaveLength(1);
    expect(merged.seamGroups).toEqual([]);
  });
});
