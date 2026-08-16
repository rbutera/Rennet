import type { Canvas } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  adjudicateProposal,
  blastNotAssessed,
  blastPaint,
  blastReasonsByChunk,
  CANVAS_LENSES,
  canvasCoverage,
  fanOutApproval,
  isEditableTarget,
  isPainted,
  MAX_RENDERED_NODES,
  NODES_PER_ROW,
  paintedChunkIds,
  refocusCursor,
  rotateLens,
  viewAfterRotate,
  windowRows,
  withoutProposal,
  zoomReducer,
} from "./logic";

// A small decisions canvas: cohort c1 spans THREE files (so a cohort approve is a
// real fan-out, not a trivial one-write), cohort c2 spans one file.
function decisionsCanvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    canvasId: "cv-decisions",
    reviewId: "rv",
    patchsetId: "ps",
    angle: "decisions",
    layers: {
      substrate: {
        chunks: [
          {
            chunkId: "c1",
            hunkIds: ["h1", "h2"],
            filePaths: ["a.ts", "b.ts", "c.ts"],
          },
          { chunkId: "c2", hunkIds: ["h3"], filePaths: ["d.ts"] },
        ],
      },
      analysis: {
        elements: [
          {
            elementKey: "e1",
            docId: "d1",
            anchor: "rennet:hunk/h1",
            kind: "decision",
            title: "D1",
          },
          {
            elementKey: "e2",
            docId: "d1",
            anchor: "rennet:hunk/h2",
            kind: "decision",
            title: "D2",
          },
          {
            elementKey: "e3",
            docId: "d1",
            anchor: "rennet:hunk/h3",
            kind: "decision",
            title: "D3",
          },
        ],
        cohorts: [
          {
            cohortKey: "cohort:c1",
            title: "First cohort",
            elementKeys: ["e1", "e2"],
          },
          {
            cohortKey: "cohort:c2",
            title: "Second cohort",
            elementKeys: ["e3"],
          },
        ],
        readingOrder: ["cohort:c1", "cohort:c2"],
      },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
    ...overrides,
  };
}

describe("fanOutApproval — approve at any granularity, one act fans out", () => {
  it("a cohort approve creates one L2 disposition per distinct anchor path in ONE act", () => {
    const trace = fanOutApproval(
      decisionsCanvas(),
      { kind: "cohort", cohortKey: "cohort:c1" },
      "approve",
    );
    // c1 spans a.ts, b.ts, c.ts → three per-anchor writes from one act.
    expect(trace.map((write) => write.path).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(trace.every((write) => write.type === "approve")).toBe(true);
    // Control: this must be a REAL fan-out, not a trivial single write.
    expect(trace.length).toBeGreaterThan(1);
  });

  it("a whole-roll-up approve covers every distinct path across all cohorts", () => {
    const trace = fanOutApproval(decisionsCanvas(), { kind: "rollup" }, "approve");
    expect(trace.map((write) => write.path).sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  it("a single-element approve resolves that element's anchor to its path(s)", () => {
    const trace = fanOutApproval(
      decisionsCanvas(),
      { kind: "anchor", elementKey: "e3" },
      "request-change",
      "needs work",
    );
    expect(trace).toEqual([{ path: "d.ts", type: "request-change", body: "needs work" }]);
  });

  it("a partial selection unions the selected elements' paths, deduplicated", () => {
    const trace = fanOutApproval(
      decisionsCanvas(),
      { kind: "selection", elementKeys: ["e1", "e3"] },
      "comment",
    );
    // e1 → c1 (a,b,c); e3 → c2 (d)
    expect(trace.map((write) => write.path).sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });
});

describe("canvasCoverage — collapse is not read", () => {
  it("reports un-dispositioned anchors as unread regardless of cohort expansion", () => {
    // No dispositions and (implicitly) every cohort collapsed: still all unread.
    const coverage = canvasCoverage(decisionsCanvas());
    expect(coverage).toEqual({ total: 4, read: 0, unread: 4 });
  });

  it("only an action (a disposition) marks a path read — control that it is not vacuous", () => {
    const canvas = decisionsCanvas();
    canvas.layers.disposition.dispositions = [
      {
        anchor: { path: "a.ts", contentDigest: "x" },
        type: "approve",
        body: "",
      },
    ];
    expect(canvasCoverage(canvas)).toEqual({ total: 4, read: 1, unread: 3 });
  });
});

describe("zoomReducer — roll-up → cohort → element → diff, both directions", () => {
  it("zooms in through every level and back out again", () => {
    let state = { level: "rollup" } as ReturnType<typeof zoomReducer>;
    state = zoomReducer(state, { type: "enterCohort", cohortKey: "cohort:c1" });
    expect(state).toEqual({ level: "cohort", cohortKey: "cohort:c1" });
    state = zoomReducer(state, { type: "enterElement", elementKey: "e1" });
    expect(state).toMatchObject({
      level: "element",
      cohortKey: "cohort:c1",
      elementKey: "e1",
    });
    state = zoomReducer(state, { type: "openDiff" });
    expect(state.level).toBe("diff");
    // …and back out, both directions reachable.
    state = zoomReducer(state, { type: "zoomOut" });
    expect(state.level).toBe("element");
    state = zoomReducer(state, { type: "zoomOut" });
    expect(state.level).toBe("cohort");
    state = zoomReducer(state, { type: "zoomOut" });
    expect(state.level).toBe("rollup");
  });

  it("zoomIn from a focused cohort advances to element then diff", () => {
    const atCohort = {
      level: "cohort",
      cohortKey: "cohort:c1",
      elementKey: "e1",
    } as ReturnType<typeof zoomReducer>;
    expect(zoomReducer(atCohort, { type: "zoomIn" }).level).toBe("element");
  });
});

describe("rotateLens + refocusCursor — five lenses, fixed cursor hunk", () => {
  it("blast-radius is NOT one of the selectable canvases (flagged is, issue #138); Claims is gone (#221)", () => {
    expect(CANVAS_LENSES).toHaveLength(5);
    expect(CANVAS_LENSES).not.toContain("blast-radius");
    expect(CANVAS_LENSES).not.toContain("claims");
    expect(CANVAS_LENSES).toContain("flagged");
  });

  it("rotation cycles spec → sequence → decisions → noise → flagged, both directions (#138, #221)", () => {
    expect(rotateLens("spec", 1)).toBe("sequence");
    expect(rotateLens("sequence", 1)).toBe("decisions");
    expect(rotateLens("decisions", 1)).toBe("noise");
    expect(rotateLens("noise", 1)).toBe("flagged");
    expect(rotateLens("flagged", 1)).toBe("spec");
    expect(rotateLens("spec", -1)).toBe("flagged");
  });

  it("keeps the hunk under the cursor fixed: the anchor re-centers on the new canvas", () => {
    const canvas = decisionsCanvas();
    // The cursor sits on hunk h2 (element e2). After rotation the new canvas carries
    // the same anchor, and refocus returns that element to re-center on.
    expect(refocusCursor(canvas, "rennet:hunk/h2")).toBe("e2");
    // An anchor absent from the new canvas simply yields no re-focus (no crash).
    expect(refocusCursor(canvas, "rennet:hunk/absent")).toBeUndefined();
  });
});

describe("adjudicateProposal — only acceptance creates L2", () => {
  const proposal = {
    proposalId: "p1",
    kind: "disposition" as const,
    target: "a.ts",
    payload: "suggested body",
    status: "pending" as const,
  };

  it("dismiss creates no L2", () => {
    expect(adjudicateProposal(proposal, "dismissed")).toEqual({
      kind: "dismiss",
      proposalId: "p1",
    });
  });

  it("accept creates an L2 disposition carrying the proposed body", () => {
    expect(adjudicateProposal(proposal, "accepted")).toEqual({
      kind: "accept-disposition",
      proposalId: "p1",
      path: "a.ts",
      type: "approve",
      body: "suggested body",
    });
  });

  it("edit-then-accept is first-class: the edited body wins", () => {
    expect(adjudicateProposal(proposal, "accepted", "my edited body")).toMatchObject({
      kind: "accept-disposition",
      body: "my edited body",
    });
  });

  it("accepting a regroup/split proposal never creates an L2 disposition", () => {
    const regroup = { ...proposal, kind: "regroup" as const };
    expect(adjudicateProposal(regroup, "accepted").kind).toBe("accept-structural");
  });
});

describe("blastPaint — amber overlay, never a queue", () => {
  it("returns the overlay targets as paint, not a canvas of their own", () => {
    const canvas = decisionsCanvas({
      overlay: [
        { target: "rennet:chunk/c1", docId: "d9" },
        { target: "rennet:chunk/c2", docId: "d9" },
      ],
    });
    expect([...blastPaint(canvas)].sort()).toEqual(["rennet:chunk/c1", "rennet:chunk/c2"]);
    expect(isPainted(canvas, "rennet:chunk/c1")).toBe(true);
    expect(isPainted(canvas, "rennet:chunk/absent")).toBe(false);
  });
});

describe("blast radius — file targets, reasons, not-assessed (issue #35)", () => {
  it("resolves rennet:file/<path> targets to the chunks that cover them", () => {
    const canvas = decisionsCanvas({
      overlay: [
        { target: "rennet:file/b.ts", signal: "deletions", reason: "gone", assessed: true }, // b.ts ∈ c1
        { target: "rennet:file/d.ts", signal: "irreversibility", reason: "drop", assessed: true }, // d.ts ∈ c2
      ],
    });
    expect([...paintedChunkIds(canvas)].sort()).toEqual(["c1", "c2"]);
  });

  it("surfaces the one-line reason on the covering chunk", () => {
    const canvas = decisionsCanvas({
      overlay: [
        {
          target: "rennet:file/b.ts",
          signal: "deletions",
          reason: "File deleted; importers break.",
          assessed: true,
        },
      ],
    });
    expect(blastReasonsByChunk(canvas).get("c1")).toContain("File deleted");
  });

  it("surfaces deferred signals as NOT ASSESSED and excludes them from the amber paint", () => {
    const canvas = decisionsCanvas({
      overlay: [
        { target: "rennet:file/a.ts", signal: "deletions", reason: "gone", assessed: true },
        {
          target: "rennet:review/blast-radius",
          signal: "fan-in",
          reason: "Fan-in not assessed.",
          assessed: false,
        },
        {
          target: "rennet:review/blast-radius",
          signal: "contract-surface",
          reason: "Contract surface not assessed.",
          assessed: false,
        },
      ],
    });
    // The deferred signals are surfaced (sorted), so the reviewer sees them as unmeasured.
    expect(blastNotAssessed(canvas).map((s) => s.signal)).toEqual(["contract-surface", "fan-in"]);
    // ...but they are NOT amber paint on any element (no false claim of risk).
    expect(paintedChunkIds(canvas).has("c1")).toBe(true);
    expect([...blastPaint(canvas)]).not.toContain("rennet:review/blast-radius");
  });
});

describe("windowRows — the Pierre node-count envelope", () => {
  it("bounds a 5000-line diff to a small window while the naive render would blow it", () => {
    const range = windowRows({
      total: 5000,
      rowHeight: 20,
      viewportHeight: 600,
      scrollTop: 4000,
      overscan: 8,
    });
    const renderedRows = range.end - range.start;
    // The window is a slice around the viewport, not the whole file.
    expect(renderedRows).toBeLessThan(80);
    expect(renderedRows * NODES_PER_ROW).toBeLessThanOrEqual(MAX_RENDERED_NODES);
    // Control: a naive full render of the same fixture exceeds the envelope.
    expect(5000 * NODES_PER_ROW).toBeGreaterThan(MAX_RENDERED_NODES);
  });

  it("clamps the window to the file bounds at the top and bottom", () => {
    const top = windowRows({
      total: 5000,
      rowHeight: 20,
      viewportHeight: 600,
      scrollTop: 0,
    });
    expect(top.start).toBe(0);
    const bottom = windowRows({
      total: 100,
      rowHeight: 20,
      viewportHeight: 600,
      scrollTop: 100000,
    });
    expect(bottom.end).toBe(100);
  });
});

describe("viewAfterRotate — the fixed point: rotation lands on the cursor hunk", () => {
  it("refocuses the cursor element on the new canvas rather than resetting to roll-up", () => {
    // The cursor sits on hunk h2 (element e2). After rotating to a canvas that
    // carries the same anchor, the view lands ON that element, not back at roll-up.
    expect(viewAfterRotate(decisionsCanvas(), "rennet:hunk/h2")).toEqual({
      selection: "e2",
      zoom: { level: "element", elementKey: "e2" },
    });
  });

  it("falls back to roll-up only when the cursor anchor is absent on the new canvas", () => {
    expect(viewAfterRotate(decisionsCanvas(), "rennet:hunk/absent")).toEqual({
      zoom: { level: "rollup" },
    });
    // Control: no cursor at all is roll-up too (nothing to refocus on).
    expect(viewAfterRotate(decisionsCanvas(), undefined)).toEqual({
      zoom: { level: "rollup" },
    });
  });
});

describe("isEditableTarget — canvas keys must not hijack text editing", () => {
  it("treats form fields and contenteditable as editable (keystrokes pass through)", () => {
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
  });

  it("treats the canvas surface itself (a div) and null as non-editable", () => {
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe("withoutProposal — adjudicating a proposal resolves it off the canvas", () => {
  it("drops the named proposal and leaves the rest", () => {
    const base = decisionsCanvas();
    const canvas: Canvas = {
      ...base,
      layers: {
        ...base.layers,
        annotation: {
          annotations: [],
          proposals: [
            {
              proposalId: "p1",
              kind: "disposition",
              target: "a.ts",
              payload: "x",
              status: "pending",
            },
            {
              proposalId: "p2",
              kind: "regroup",
              target: "b.ts",
              payload: "y",
              status: "pending",
            },
          ],
        },
      },
    };
    const after = withoutProposal(canvas, "p1");
    expect(after.layers.annotation.proposals.map((p) => p.proposalId)).toEqual(["p2"]);
    // Control: an unknown id is a no-op, not an accidental wipe.
    expect(withoutProposal(canvas, "nope").layers.annotation.proposals).toHaveLength(2);
  });
});
