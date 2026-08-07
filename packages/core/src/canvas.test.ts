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
  carrySuccessorDispositions,
  dispatchOrchestratorCanvasOp,
  dispatchUserCanvasCommand,
  fileContentDigest,
  foldCanvas,
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
  const events: CanvasEvent[] = [
    {
      type: "CanvasAnnotated",
      version: 1,
      canvasId: "x",
      annotation: {
        annotationId: "an1",
        target: "e",
        kind: "callout",
        body: "look here",
        pinned: false,
      },
    },
    { type: "AnnotationPinned", version: 1, canvasId: "x", annotationId: "an1" },
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

  it("projects the same admitted docs to a deep-equal analysis layer", () => {
    expect(projectAnalysis("decisions", docs, DECOMP)).toEqual(
      projectAnalysis("decisions", docs, DECOMP),
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

  it("never caps a cohort (500 decisions all placed)", () => {
    const many = Array.from({ length: 500 }, (_, index) => ({
      decisionId: `d${index}`,
      anchor: "rennet:chunk/c1",
      title: `decision ${index}`,
    }));
    const layer = projectAnalysis("decisions", [decisionsDoc(many)], DECOMP);
    const cohort = layer.cohorts.find((c) => c.cohortKey === "cohort:c1");
    expect(cohort?.elementKeys).toHaveLength(500);
    expect(layer.elements).toHaveLength(500);
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
        canvasId: "x",
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
        canvasId: "x",
        annotation: {
          annotationId: "drop",
          target: "e2",
          kind: "highlight",
          body: "",
          pinned: false,
        },
      },
      { type: "AnnotationPinned", version: 1, canvasId: "x", annotationId: "keep" },
      { type: "SessionEnded", version: 1, canvasId: "x" },
    ];
    const state = foldCanvas(events);
    expect(state.annotations.map((a) => a.annotationId)).toEqual(["keep"]);
    expect(state.annotations[0]?.pinned).toBe(true);
  });
});

// ── AC5: successor-canvas carry is exact-lineage only ────────────────────────

describe("successor-canvas carry is exact-lineage only (AC5)", () => {
  it("carries an unchanged file's approval and drops a changed file's", () => {
    const unchangedPatch = "@@ -1 +1 @@\n-old\n+new-a";
    const changedNext = "@@ -1 +2 @@\n-old\n+new-b-CHANGED";
    const next = patchset("ps_2", [
      patchFile("a.ts", unchangedPatch),
      patchFile("b.ts", changedNext),
    ]);

    const previous: Disposition[] = [
      {
        anchor: {
          path: "a.ts",
          contentDigest: fileContentDigest(patchFile("a.ts", unchangedPatch)),
        },
        type: "approve",
        body: "",
      },
      {
        anchor: {
          path: "b.ts",
          contentDigest: fileContentDigest(patchFile("b.ts", "@@ -1 +1 @@\n-old\n+new-b-ORIGINAL")),
        },
        type: "approve",
        body: "",
      },
    ];

    const carried = carrySuccessorDispositions(previous, next);
    expect(carried.map((d) => d.anchor.path)).toEqual(["a.ts"]);
  });
});
