import type {
  Annotation,
  Canvas,
  CanvasAngle,
  Disposition,
  Proposal,
  SubstrateChunkRef,
} from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic demo canvases (issue #11).
//
// The engine-real canvas feed (a `canvas.snapshot` read command + change-feed
// subscription, #31) is a follow-up; the issue sanctions "early development
// against fixture docs". These fixtures back both the tests and the demo shell so
// the five canvases are populated and clickable in Electron NOW.
// ─────────────────────────────────────────────────────────────────────────────

const REVIEW_ID = "demo-review";
const PATCHSET_ID = "demo-patchset";

/** A shared substrate: ten chunks, some spanning several files (real fan-out). */
function demoChunks(): SubstrateChunkRef[] {
  return Array.from({ length: 10 }, (_unused, index) => {
    const n = index + 1;
    const fileCount = (index % 3) + 1;
    return {
      chunkId: `c${n}`,
      hunkIds: Array.from({ length: 12 }, (_u, h) => `c${n}-h${h + 1}`),
      filePaths: Array.from({ length: fileCount }, (_u, f) => `src/module-${n}/file-${f + 1}.ts`),
    };
  });
}

const CHUNK_TITLES = [
  "Establish the review store schema",
  "Wire the capture adapter",
  "Add the disposition command",
  "Fold read-state from actions",
  "Project the analysis layer",
  "Group decisions into cohorts",
  "Order chunks for comprehension",
  "Paint the blast-radius overlay",
  "Assemble the four-layer canvas",
  "Carry approvals to the successor",
];

const DECISION_LEADS = [
  "Keyed the store per repository root",
  "Made read-state action-defined, not scroll",
  "Chose exact-lineage carry, fail-closed",
  "Hard-baked cohort grouping (OQ17)",
  "Placed elements by derived key, order-free",
  "Never capped the decisions list",
  "Threaded the DAG through the ordering floor",
  "Left the overlay as paint, never a queue",
  "Held L2 sovereign in the command surface",
  "Emitted one change notification per key",
  "Bounded the diff render to a window",
  "Disposed every subscription on unmount",
];

function chunkForCohort(index: number): string {
  return `c${(index % 10) + 1}`;
}

/**
 * The decisions canvas: ~120 decisions across ten cohorts, uncapped and grouped
 * (OQ17), ordered by the reading order. Cohorts collapse by default in the view
 * store — the canvas itself carries every decision.
 */
function decisionsCanvas(): Canvas {
  const chunks = demoChunks();
  const cohorts = CHUNK_TITLES.map((title, cohortIndex) => {
    const chunkId = chunkForCohort(cohortIndex);
    const elementKeys = Array.from({ length: 12 }, (_u, d) => `dec-${cohortIndex + 1}-${d + 1}`);
    return { cohortKey: `cohort:${chunkId}`, title, elementKeys };
  });
  const elements = cohorts.flatMap((cohort, cohortIndex) =>
    cohort.elementKeys.map((elementKey, d) => ({
      elementKey,
      docId: `dec-doc-${cohortIndex + 1}`,
      anchor: `rennet:hunk/${chunkForCohort(cohortIndex)}-h${d + 1}`,
      kind: "decision",
      title: `${DECISION_LEADS[d % DECISION_LEADS.length]} (${cohortIndex + 1}.${d + 1})`,
    })),
  );
  return {
    canvasId: `${REVIEW_ID}\0${PATCHSET_ID}\0decisions`,
    reviewId: REVIEW_ID,
    patchsetId: PATCHSET_ID,
    angle: "decisions",
    layers: {
      substrate: { chunks },
      analysis: {
        elements,
        cohorts,
        readingOrder: cohorts.map((cohort) => cohort.cohortKey),
      },
      disposition: { dispositions: demoDispositions() },
      annotation: { annotations: [demoAnnotation()], proposals: [demoProposal()] },
    },
    overlay: [
      { target: "rennet:chunk/c8", docId: "blast-doc" },
      { target: "rennet:hunk/c8-h1", docId: "blast-doc" },
    ],
  };
}

/** A couple of already-disposed anchors so coverage reads non-zero in the demo. */
function demoDispositions(): Disposition[] {
  return [
    { anchor: { path: "src/module-1/file-1.ts", contentDigest: "d1" }, type: "approve", body: "" },
    {
      anchor: { path: "src/module-2/file-1.ts", contentDigest: "d2" },
      type: "comment",
      body: "checked the adapter",
    },
  ];
}

/** An L3 annotation (the orchestrator's hand — glass chrome, visually distinct). */
function demoAnnotation(): Annotation {
  return {
    annotationId: "ann-1",
    target: "rennet:hunk/c6-h1",
    kind: "callout",
    body: "These two decisions share a cohort because they land in the same chunk.",
    pinned: false,
  };
}

/** An L3 disposition proposal (accept/edit/dismiss; only accept creates L2). */
function demoProposal(): Proposal {
  return {
    proposalId: "prop-1",
    kind: "disposition",
    target: "src/module-6/file-1.ts",
    payload: "Looks correct — safe to approve.",
    status: "pending",
  };
}

/** The sequence canvas: chunk elements in the reading order (the decomposition). */
function sequenceCanvas(): Canvas {
  const chunks = demoChunks();
  const elements = chunks.map((chunk, index) => ({
    elementKey: `seq-${chunk.chunkId}`,
    docId: "seq-doc",
    anchor: `rennet:chunk/${chunk.chunkId}`,
    kind: "chunk",
    title: CHUNK_TITLES[index] ?? chunk.chunkId,
  }));
  return {
    canvasId: `${REVIEW_ID}\0${PATCHSET_ID}\0sequence`,
    reviewId: REVIEW_ID,
    patchsetId: PATCHSET_ID,
    angle: "sequence",
    layers: {
      substrate: { chunks },
      analysis: { elements, cohorts: [], readingOrder: elements.map((el) => el.elementKey) },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [{ target: "rennet:chunk/c8", docId: "blast-doc" }],
  };
}

/** A flat angle canvas (spec/claims/noise) with a handful of honest elements. */
function flatCanvas(angle: CanvasAngle, kind: string, titles: string[]): Canvas {
  const chunks = demoChunks();
  const elements = titles.map((title, index) => ({
    elementKey: `${angle}-${index + 1}`,
    docId: `${angle}-doc-${index + 1}`,
    anchor: `rennet:doc/${angle}-doc-${index + 1}`,
    kind,
    title,
  }));
  return {
    canvasId: `${REVIEW_ID}\0${PATCHSET_ID}\0${angle}`,
    reviewId: REVIEW_ID,
    patchsetId: PATCHSET_ID,
    angle,
    layers: {
      substrate: { chunks },
      analysis: { elements, cohorts: [], readingOrder: elements.map((el) => el.elementKey) },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  };
}

/** The five demo canvases, keyed by angle. */
export function demoCanvases(): Record<CanvasAngle, Canvas> {
  return {
    decisions: decisionsCanvas(),
    sequence: sequenceCanvas(),
    spec: flatCanvas("spec", "requirement", [
      "The review survives a force-push",
      "Read state is defined by an action",
      "Decisions are never truncated",
    ]),
    claims: flatCanvas("claims", "claim", []),
    noise: flatCanvas("noise", "group", [
      "Formatting-only churn in three files",
      "Import reordering across the module",
    ]),
  };
}

/** A demo diff for the CodeView surface (a real-ish patch body). */
export function demoDiff(lineCount = 5000): string {
  return Array.from({ length: lineCount }, (_u, index) => {
    const n = index + 1;
    if (n % 7 === 0) return `-  const legacy${n} = compute(${n});`;
    if (n % 5 === 0) return `+  const value${n} = compute(${n}) + 1;`;
    return `   const value${n} = compute(${n});`;
  }).join("\n");
}
