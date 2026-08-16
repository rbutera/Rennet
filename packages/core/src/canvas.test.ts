import type {
  DecisionRecordBody,
  Decomposition,
  DecompositionProposalBody,
  Disposition,
  PatchFile,
  Patchset,
} from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  type AdmittedDocument,
  buildCanvas,
  type CanvasEvent,
  canvasDigest,
  canvasId,
  dispatchOrchestratorCanvasOp,
  dispatchUserCanvasCommand,
  fileContentDigest,
  foldCanvas,
  foldReview,
  ORCHESTRATOR_CANVAS_OPS,
  ORCHESTRATOR_EMITTABLE_EVENT_TYPES,
  projectAnalysis,
  USER_CANVAS_COMMANDS,
} from "./index";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DECOMP: Decomposition = {
  patchsetId: "ps_1",
  hunks: [],
  classifications: [],
  chunks: [
    {
      chunkId: "c1",
      kind: "substantive",
      title: "schema",
      layer: 0,
      filePaths: ["a.ts"],
      hunkIds: ["h1"],
      changedLoc: 3,
    },
    {
      chunkId: "c2",
      kind: "substantive",
      title: "core",
      layer: 2,
      filePaths: ["b.ts"],
      hunkIds: ["h2"],
      changedLoc: 4,
    },
    {
      chunkId: "c3",
      kind: "substantive",
      title: "ui",
      layer: 3,
      filePaths: ["c.ts"],
      hunkIds: ["h3"],
      changedLoc: 2,
    },
  ],
  edges: [{ from: "c1", to: "c2", kind: "enables" }],
  readingOrder: ["c1", "c2", "c3"],
  residue: [],
  blockingStates: [],
};

const decisionsDoc = (
  decisions: DecisionRecordBody["decisions"],
  docId = "doc-dec",
): AdmittedDocument => ({
  docId,
  docType: "decision.record",
  body: { decisions } satisfies DecisionRecordBody,
});

const PROPOSAL: DecompositionProposalBody = {
  chunks: [
    { chunkId: "c1", title: "schema", hunkIds: ["h1"], angles: ["sequence"], rationale: "base" },
    {
      chunkId: "c2",
      title: "core",
      hunkIds: ["h2"],
      angles: ["sequence", "blast-radius"],
      rationale: "mid",
    },
    { chunkId: "c3", title: "ui", hunkIds: ["h3"], angles: ["sequence"], rationale: "top" },
  ],
  edges: [{ from: "c1", to: "c2", kind: "enables" }],
  readingOrder: ["c1", "c2", "c3"],
  residue: [],
};

const proposalDoc: AdmittedDocument = {
  docId: "doc-prop",
  docType: "decomposition.proposal",
  body: PROPOSAL,
};

const patchFile = (path: string, patch: string): PatchFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
  patch,
});

const patchset = (id: string, files: PatchFile[]): Patchset => ({
  id,
  createdAt: "2026-08-07T00:00:00.000Z",
  repository: {
    id: "r",
    root: "/r",
    commonDir: "/r/.git",
    baseRef: "main",
    baseOid: "o",
    headOid: "h",
  },
  files,
  rawDiff: files.map((f) => f.patch).join("\n"),
  byteLength: 0,
  truncated: false,
});

// ── AC1: byte-identical replay ───────────────────────────────────────────────

describe("buildCanvas rebuilds byte-identically from event replay (AC1)", () => {
  // Events are addressed to THIS canvas's real (hashed) id, not a placeholder —
  // otherwise the canvas-scoped fold drops them and the replay test proves nothing.
  const cid = canvasId("rev1", "ps_1", "decisions");
  const events: CanvasEvent[] = [
    {
      type: "CanvasAnnotated",
      version: 1,
      canvasId: cid,
      annotation: {
        annotationId: "an1",
        target: "e",
        kind: "callout",
        body: "look here",
        pinned: false,
      },
    },
    { type: "AnnotationPinned", version: 1, canvasId: cid, annotationId: "an1" },
  ];
  const input = {
    reviewId: "rev1",
    patchsetId: "ps_1",
    angle: "decisions" as const,
    admittedDocs: [
      decisionsDoc([{ decisionId: "d1", anchor: "rennet:chunk/c2", title: "use a queue" }]),
    ],
    decomposition: DECOMP,
    dispositions: [] as Disposition[],
    canvasEvents: events,
  };

  it("actually places the replayed annotation (guards against a vacuous replay)", () => {
    const canvas = buildCanvas(input);
    expect(canvas.layers.annotation.annotations.map((a) => a.annotationId)).toEqual(["an1"]);
    expect(canvas.layers.annotation.annotations[0]?.pinned).toBe(true);
  });

  it("produces an equal canonical digest on replay", () => {
    const first = canvasDigest(buildCanvas(input));
    const second = canvasDigest(buildCanvas({ ...input, canvasEvents: [...events] }));
    expect(second).toBe(first);
  });
});

// ── AC2: placement determinism + decisions never capped ──────────────────────

describe("L1 placement is a deterministic pure function (AC2)", () => {
  const docs = [
    decisionsDoc([
      { decisionId: "d-late", anchor: "rennet:chunk/c2", title: "in the later cohort" },
      { decisionId: "d-early", anchor: "rennet:chunk/c1", title: "in the earlier cohort" },
    ]),
  ];

  it("is a pure function of the admitted-doc SET: permuted, independently-built inputs project identically", () => {
    // Two INDEPENDENT doc lists (not the same reference), one the reverse of the
    // other, including two decisions in the SAME cohort so within-cohort order is
    // exercised. A pure placement gives byte-identical output regardless of input
    // order; input-order dependence or element-key collisions make these diverge.
    const build = (reversed: boolean): AdmittedDocument[] => {
      const decisions = [
        { decisionId: "d1", anchor: "rennet:chunk/c1", title: "one" },
        { decisionId: "d2", anchor: "rennet:chunk/c1", title: "two" },
        { decisionId: "d3", anchor: "rennet:chunk/c2", title: "three" },
      ];
      return [decisionsDoc(reversed ? [...decisions].reverse() : decisions)];
    };
    expect(projectAnalysis("decisions", build(true), DECOMP)).toEqual(
      projectAnalysis("decisions", build(false), DECOMP),
    );
  });

  it("orders cohorts by anchored-chunk DAG position, never by input order", () => {
    const layer = projectAnalysis("decisions", docs, DECOMP);
    expect(layer.readingOrder).toEqual(["cohort:c1", "cohort:c2"]);
  });

  it("derives element identity from docId + anchor, minting none", () => {
    const layer = projectAnalysis("decisions", docs, DECOMP);
    for (const element of layer.elements) {
      expect(element.elementKey).toHaveLength(64); // sha256 hex — derived, not an agent id
      expect(element.elementKey).not.toBe(element.docId);
    }
  });

  it("never caps a cohort and mints a UNIQUE key per decision (500 placed, 500 distinct)", () => {
    // All 500 decisions share one anchor — the normal cohort case. Keying on
    // docId+anchor alone would collapse them to ONE key; a length check would
    // still pass. Uniqueness is what proves each decision is separately placed.
    const many = Array.from({ length: 500 }, (_, index) => ({
      decisionId: `d${index}`,
      anchor: "rennet:chunk/c1",
      title: `decision ${index}`,
    }));
    const layer = projectAnalysis("decisions", [decisionsDoc(many)], DECOMP);
    const cohort = layer.cohorts.find((c) => c.cohortKey === "cohort:c1");
    expect(cohort?.elementKeys).toHaveLength(500);
    expect(new Set(cohort?.elementKeys).size).toBe(500);
    expect(layer.elements).toHaveLength(500);
    expect(new Set(layer.elements.map((element) => element.elementKey)).size).toBe(500);
  });

  it("places the sequence canvas in the admitted reading order and paints the overlay", () => {
    const canvas = buildCanvas({
      reviewId: "rev1",
      patchsetId: "ps_1",
      angle: "sequence",
      admittedDocs: [proposalDoc],
      decomposition: DECOMP,
      dispositions: [],
      canvasEvents: [],
    });
    expect(canvas.layers.analysis.elements.map((e) => e.anchor)).toEqual([
      "rennet:chunk/c1",
      "rennet:chunk/c2",
      "rennet:chunk/c3",
    ]);
    expect(canvas.overlay).toEqual([{ target: "rennet:chunk/c2", docId: "doc-prop" }]);
  });
});

// ── AC3: L2 is user-sovereign, enforced structurally ─────────────────────────

describe("no agent-reachable path can write L2 (AC3, structural)", () => {
  it("has no disposition writer in the orchestrator vocabulary", () => {
    expect(ORCHESTRATOR_CANVAS_OPS).not.toContain("canvas.disposition");
  });

  it("emits no disposition event from any orchestrator op", () => {
    for (const op of ORCHESTRATOR_CANVAS_OPS) {
      const effect = dispatchOrchestratorCanvasOp(op, {});
      expect(effect.kind).not.toBe("disposition");
      if ("event" in effect) {
        expect(effect.event.type).not.toBe("DispositionSet");
        expect(effect.event.type).not.toBe("DispositionCleared");
      }
    }
  });

  it("restricts orchestrator-emittable events to the L3 set", () => {
    expect(ORCHESTRATOR_EMITTABLE_EVENT_TYPES).not.toContain("DispositionSet");
    expect([...ORCHESTRATOR_EMITTABLE_EVENT_TYPES].sort()).toEqual([
      "CanvasAnnotated",
      "ProposalRaised",
    ]);
  });

  it("reaches L2 only through the user surface", () => {
    expect(USER_CANVAS_COMMANDS).toContain("canvas.disposition");
    const effect = dispatchUserCanvasCommand("canvas.disposition", {
      anchorPath: "a.ts",
      type: "approve",
      body: "",
    });
    expect(effect.kind).toBe("disposition");
  });

  it("turns an ACCEPTED proposal into an L2 disposition — a user act", () => {
    const accepted = dispatchUserCanvasCommand("canvas.adjudicateProposal", {
      outcome: "accepted",
      anchorPath: "a.ts",
      type: "approve",
    });
    expect(accepted.kind).toBe("disposition");
    const dismissed = dispatchUserCanvasCommand("canvas.adjudicateProposal", {
      outcome: "dismissed",
    });
    expect(dismissed.kind).toBe("proposalAdjudicated");
  });
});

// ── AC4: L3 annotations are session-scoped ───────────────────────────────────

describe("L3 annotations are session-scoped (AC4)", () => {
  it("drops unpinned annotations at session end and keeps pinned ones", () => {
    const events: CanvasEvent[] = [
      {
        type: "CanvasAnnotated",
        version: 1,
        canvasId: "cv-a",
        annotation: {
          annotationId: "keep",
          target: "e1",
          kind: "highlight",
          body: "",
          pinned: false,
        },
      },
      {
        type: "CanvasAnnotated",
        version: 1,
        canvasId: "cv-a",
        annotation: {
          annotationId: "drop",
          target: "e2",
          kind: "highlight",
          body: "",
          pinned: false,
        },
      },
      { type: "AnnotationPinned", version: 1, canvasId: "cv-a", annotationId: "keep" },
      { type: "SessionEnded", version: 1, canvasId: "cv-a" },
    ];
    const state = foldCanvas("cv-a", events);
    expect(state.annotations.map((a) => a.annotationId)).toEqual(["keep"]);
    expect(state.annotations[0]?.pinned).toBe(true);
  });

  it("is canvas-scoped: an annotation on one canvas never appears on another, and a SessionEnded for canvas A leaves canvas B untouched", () => {
    const events: CanvasEvent[] = [
      {
        type: "CanvasAnnotated",
        version: 1,
        canvasId: "cv-a",
        annotation: {
          annotationId: "a-note",
          target: "e1",
          kind: "highlight",
          body: "",
          pinned: false,
        },
      },
      {
        type: "CanvasAnnotated",
        version: 1,
        canvasId: "cv-b",
        annotation: {
          annotationId: "b-note",
          target: "e2",
          kind: "highlight",
          body: "",
          pinned: false,
        },
      },
      // A's session ends. It must clear only A's unpinned note, never touch B's.
      { type: "SessionEnded", version: 1, canvasId: "cv-a" },
    ];
    expect(foldCanvas("cv-a", events).annotations.map((a) => a.annotationId)).toEqual([]);
    expect(foldCanvas("cv-b", events).annotations.map((a) => a.annotationId)).toEqual(["b-note"]);
  });
});

// ── AC5: successor-canvas carry is exact-lineage only ────────────────────────

describe("successor-canvas carry is exact-lineage only, on the LIVE path (AC5)", () => {
  it("a changed hunk's approval does NOT appear in the successor canvas L2; the unchanged one does", () => {
    // The successor canvas has no carry logic of its own — it reads the review's
    // dispositions, which the LIVE review fold (PatchsetActivated → carry) has
    // already narrowed to byte-identical anchors. Drive that live path, then build
    // the successor canvas and assert what its L2 layer shows.
    const p1 = patchset("ps_1", [patchFile("a.ts", "AAA"), patchFile("b.ts", "BBB")]);
    let review = foldReview(null, {
      type: "ReviewCreated",
      version: 1,
      reviewId: "rev1",
      patchset: p1,
    });
    for (const [path, patch] of [
      ["a.ts", "AAA"],
      ["b.ts", "BBB"],
    ] as const) {
      review = foldReview(review, {
        type: "DispositionSet",
        version: 1,
        reviewId: "rev1",
        patchsetId: "ps_1",
        disposition: {
          anchor: { path, contentDigest: fileContentDigest(patchFile(path, patch)) },
          type: "approve",
          body: "",
        },
      });
    }
    // Successor patchset: a.ts byte-identical, b.ts changed.
    const p2 = patchset("ps_2", [patchFile("a.ts", "AAA"), patchFile("b.ts", "BBB-CHANGED")]);
    review = foldReview(review, {
      type: "PatchsetActivated",
      version: 1,
      reviewId: "rev1",
      patchset: p2,
    });

    const canvas = buildCanvas({
      reviewId: "rev1",
      patchsetId: "ps_2",
      angle: "spec",
      admittedDocs: [],
      decomposition: { ...DECOMP, patchsetId: "ps_2" },
      dispositions: review.dispositions,
      canvasEvents: [],
    });
    expect(canvas.layers.disposition.dispositions.map((d) => d.anchor.path)).toEqual(["a.ts"]);
  });
});

// ── Flagged canvas (issue #138) ──────────────────────────────────────────────

describe("projectAnalysis — flagged", () => {
  const findingDoc = (findings: unknown[], docId = "doc-find"): AdmittedDocument => ({
    docId,
    docType: "finding",
    body: { findings },
  });

  const concur = { kind: "concur", agree: 3, total: 3 };
  const good = (findingId: string, severity: string, anchor = `rennet:hunk/${findingId}`) => ({
    findingId,
    anchor,
    summary: `finding ${findingId}`,
    severity,
    agreement: concur,
  });

  it("routes admitted finding docs to the flagged angle, one element per finding", () => {
    const layer = projectAnalysis("flagged", [findingDoc([good("f1", "high")])], DECOMP);
    expect(layer.elements).toHaveLength(1);
    expect(layer.elements[0]?.anchor).toBe("rennet:hunk/f1");
    expect(layer.elements[0]?.kind).toBe("finding:high");
    expect(layer.elements[0]?.title).toBe("finding f1");
  });

  it("orders by severity high → medium → low, input-order independent", () => {
    const build = (reversed: boolean) => {
      const findings = [good("a", "high"), good("m", "medium"), good("z", "low")];
      return [findingDoc(reversed ? [...findings].reverse() : findings)];
    };
    const forward = projectAnalysis("flagged", build(false), DECOMP);
    const reversed = projectAnalysis("flagged", build(true), DECOMP);
    expect(forward).toEqual(reversed);
    expect(forward.elements.map((element) => element.kind)).toEqual([
      "finding:high",
      "finding:medium",
      "finding:low",
    ]);
  });

  // Acceptance criterion: a validator rejection / malformed item is NEVER a flag.
  it("NEVER places a malformed (rejected-item-shaped) finding as a flag", () => {
    const rejected = { rejectionReason: "schema: missing 'severity'", raw: { anchor: "x" } };
    const badAgreement = { ...good("bad", "high"), agreement: { kind: "maybe" } };
    const layer = projectAnalysis(
      "flagged",
      [findingDoc([rejected, badAgreement, good("real", "high")])],
      DECOMP,
    );
    expect(layer.elements).toHaveLength(1);
    expect(layer.elements[0]?.title).toBe("finding real");
  });

  it("renders empty-but-honest when no finding docs are admitted", () => {
    const layer = projectAnalysis("flagged", [], DECOMP);
    expect(layer.elements).toEqual([]);
    expect(layer.readingOrder).toEqual([]);
  });

  it("does not route non-finding docs into the flagged angle", () => {
    const layer = projectAnalysis(
      "flagged",
      [decisionsDoc([{ decisionId: "d1", anchor: "rennet:chunk/c1", title: "x" }])],
      DECOMP,
    );
    expect(layer.elements).toEqual([]);
  });

  it("mints a derived (sha256) key per finding, never an agent id", () => {
    const layer = projectAnalysis(
      "flagged",
      [findingDoc([good("f1", "high"), good("f2", "low")])],
      DECOMP,
    );
    expect(new Set(layer.elements.map((element) => element.elementKey)).size).toBe(2);
    for (const element of layer.elements) expect(element.elementKey).toHaveLength(64);
  });
});

// ── Decisions carry rich detail: evidence chips + reconstructed why (issue #137) ──

describe("projectDecisions carries the rich decision detail (issue #137)", () => {
  const richDoc = decisionsDoc([
    {
      decisionId: "d-store",
      anchor: "rennet:chunk/c1",
      title: "Keyed the store per repo root",
      evidence: [
        { kind: "spec", label: "spec §2.1", detail: "survives a force-push" },
        { kind: "hunk", label: "store.ts +18", detail: "key = commonDir" },
      ],
      why: { reconstructed: true, text: "branch-keying drops the review on rename" },
      alternatives: ["key per branch ref"],
    },
    {
      // A decision with NO discernible rationale: it must still render.
      decisionId: "d-noreason",
      anchor: "rennet:chunk/c2",
      title: "Left the import reorder in place",
    },
  ]);

  it("places evidence chips + a reconstructed why onto the decision element", () => {
    const layer = projectAnalysis("decisions", [richDoc], DECOMP);
    const el = layer.elements.find((e) => e.title === "Keyed the store per repo root");
    expect(el?.decision?.evidence.map((c) => c.kind)).toEqual(["spec", "hunk"]);
    // The literal-true marker is load-bearing: a why exists ONLY as reconstructed.
    expect(el?.decision?.why?.reconstructed).toBe(true);
    expect(el?.decision?.why?.text).toContain("branch-keying");
    expect(el?.decision?.alternatives).toEqual(["key per branch ref"]);
  });

  it("renders a decision with NO discernible rationale rather than inventing one", () => {
    const layer = projectAnalysis("decisions", [richDoc], DECOMP);
    const el = layer.elements.find((e) => e.title === "Left the import reorder in place");
    expect(el).toBeDefined(); // still placed on title + evidence alone
    expect(el?.decision?.why).toBeUndefined(); // no fabricated rationale
    expect(el?.decision?.evidence).toEqual([]);
    expect(el?.decision?.alternatives).toEqual([]);
  });

  it("groups by anchored chunk — the chunk title IS the theme label", () => {
    const layer = projectAnalysis("decisions", [richDoc], DECOMP);
    expect(layer.cohorts.map((c) => c.title)).toEqual(["schema", "core"]);
  });

  it("emits NO evidenced / mechanical / contestable triage bucket in the data", () => {
    const layer = projectAnalysis("decisions", [richDoc], DECOMP);
    const serialized = JSON.stringify(layer).toLowerCase();
    expect(serialized).not.toContain("evidenced");
    expect(serialized).not.toContain("contestable");
    expect(serialized).not.toContain("mechanical");
  });
});
