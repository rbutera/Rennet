import type { Canvas, CanvasAngle } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { canvasSchema, isCommandName, parseCommandInput, parseCommandOutput } from "./index";

function emptyCanvas(angle: CanvasAngle): Canvas {
  return {
    canvasId: `cid-${angle}`,
    reviewId: "review-1",
    patchsetId: "patch-1",
    angle,
    layers: {
      substrate: { chunks: [{ chunkId: "c1", hunkIds: ["h1"], filePaths: ["src/a.ts"] }] },
      analysis: {
        elements: [
          { elementKey: "e1", docId: "d1", anchor: "rennet:chunk/c1", kind: "chunk", title: "A" },
        ],
        cohorts: [],
        readingOrder: ["e1"],
      },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  };
}

function canvasSet(): Record<CanvasAngle, Canvas> {
  return Object.fromEntries(CANVAS_ANGLES.map((angle) => [angle, emptyCanvas(angle)])) as Record<
    CanvasAngle,
    Canvas
  >;
}

describe("review.canvases command", () => {
  it("is a known command", () => {
    expect(isCommandName("review.canvases")).toBe(true);
  });

  it("round-trips a five-angle canvas set + the element diff map through the output schema", () => {
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {
        e1: {
          path: "src/a.ts",
          paths: ["src/a.ts"],
          diff: "@@ -1,1 +1,2 @@\n+added",
          hunkOccurrences: [],
        },
      },
    });
    expect(Object.keys(output.canvases).sort()).toEqual([...CANVAS_ANGLES].sort());
    expect(output.canvases.sequence.layers.analysis.elements[0]?.title).toBe("A");
    expect(output.elementDiffs.e1?.path).toBe("src/a.ts");
    expect(output.elementDiffs.e1?.diff).toContain("+added");
  });

  it("preserves hunkOccurrences on each element diff across the boundary (#84 P0)", () => {
    // The mark↔row mapping is what makes occurrence marks land. If the output schema
    // omits the field, Zod STRIPS it here and every content row reaches the renderer
    // identity-less — no mark can place. This is the boundary the projector/registrar
    // unit tests cannot see, so it is asserted directly against the real IPC parse.
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {
        e1: {
          path: "src/a.ts",
          paths: ["src/a.ts"],
          diff: "@@ -1,1 +1,2 @@\n+added",
          hunkOccurrences: [[{ id: "h1", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }]],
        },
      },
    });
    expect(output.elementDiffs.e1?.hunkOccurrences).toEqual([
      [{ id: "h1", oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }],
    ]);
  });

  it("rejects a malformed element diff entry (positive control)", () => {
    expect(() =>
      parseCommandOutput("review.canvases", {
        canvases: canvasSet(),
        // `diff` missing → the elementDiffs schema must fail.
        elementDiffs: { e1: { path: "src/a.ts" } },
      }),
    ).toThrow();
  });

  it("requires the elementDiffs field (positive control)", () => {
    expect(() => parseCommandOutput("review.canvases", { canvases: canvasSet() })).toThrow();
  });

  it("parses a valid input (no consent token — running the model just runs)", () => {
    const input = parseCommandInput("review.canvases", {
      commandId: "018f2c3d-0000-7000-8000-000000000000",
      reviewId: "review-1",
      repoPath: "/repo",
    });
    expect(input.reviewId).toBe("review-1");
  });

  it("rejects a malformed canvas (positive control)", () => {
    const broken = canvasSet();
    // Drop a required layer so the schema must fail. `elementDiffs` is supplied
    // (valid) so the throw is attributable to CANVAS validation specifically —
    // otherwise this control fires for the missing-elementDiffs reason (already
    // covered above) and never exercises the canvas schema at all.
    (broken.sequence.layers as { substrate?: unknown }).substrate = undefined;
    expect(() =>
      parseCommandOutput("review.canvases", { canvases: broken, elementDiffs: {} }),
    ).toThrow();
  });

  it("canvasSchema accepts a valid canvas and rejects a non-object", () => {
    expect(() => canvasSchema.parse(emptyCanvas("spec"))).not.toThrow();
    expect(() => canvasSchema.parse({ canvasId: "x" })).toThrow();
  });

  // ── decisionsRun delivery (issue #137/#160) ─────────────────────────────────
  // The Decisions failed state MUST survive the command boundary. The output is a
  // strict z.object, so an unschema'd field is silently stripped — and stripping
  // `decisionsRun` would make "the decisions pass crashed" render identical to
  // "found nothing" (the exact false-verdict #160 removes). These assertions go red
  // if the field is ever dropped from the schema.
  it("carries a FAILED decisionsRun status through the output (reaches the failed banner)", () => {
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {},
      decisionsRun: { status: "failed", reason: "the extraction runner timed out" },
    });
    expect(output.decisionsRun).toEqual({
      status: "failed",
      reason: "the extraction runner timed out",
    });
  });

  it("carries an OK decisionsRun status through the output", () => {
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {},
      decisionsRun: { status: "ok" },
    });
    expect(output.decisionsRun).toEqual({ status: "ok" });
  });

  it("round-trips WITHOUT decisionsRun unchanged (pre-#160 shape preserved)", () => {
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {},
    });
    expect(output.decisionsRun).toBeUndefined();
  });

  it("rejects a failed decisionsRun with no reason (positive control)", () => {
    expect(() =>
      parseCommandOutput("review.canvases", {
        canvases: canvasSet(),
        elementDiffs: {},
        decisionsRun: { status: "failed" },
      }),
    ).toThrow();
  });

  // ── blast-radius overlay paint (issue #35) ──────────────────────────────────
  // The blast paint's OPTIONAL fields (`signal`/`reason`/`assessed`) are declared by
  // hand in the schema because a plain z.object STRIPS any unlisted key at the IPC
  // boundary. If they are ever dropped, a deterministic paint arrives with only its
  // `target` — the amber renders with no signal label and no reason, and a DEFERRED
  // (not-assessed) paint arrives looking assessed, so "not measured" reads as "clear".
  // The pre-existing overlay:[] round-trip could never have caught that (it carries no
  // paint). These assertions go red if any of the three fields is dropped from the schema.
  it("preserves a complete ASSESSED blast paint across the boundary (#35)", () => {
    const canvases = canvasSet();
    canvases.sequence.overlay = [
      {
        target: "rennet:file/packages/a/gone.ts",
        signal: "deletions",
        reason: "File deleted (12 lines); anything importing it breaks.",
        assessed: true,
      },
    ];
    const output = parseCommandOutput("review.canvases", { canvases, elementDiffs: {} });
    expect(output.canvases.sequence.overlay).toEqual([
      {
        target: "rennet:file/packages/a/gone.ts",
        signal: "deletions",
        reason: "File deleted (12 lines); anything importing it breaks.",
        assessed: true,
      },
    ]);
  });

  // ── contextManifest delivery (issue #30) ───────────────────────────────────
  // The "what was sent" manifest MUST survive the command boundary intact. The
  // output is a strict z.object, so an unschema'd field — or an unschema'd member
  // inside the manifest — is silently stripped, and the "what was sent" panel would
  // render a manifest missing exactly the assembly records it exists to show. These
  // assertions go red if the manifest field or any of its records is dropped.
  it("carries the full contextManifest through the output, no field stripped (#30)", () => {
    const manifest = {
      repoRecordId: "/repo",
      projectSnapshotId: "fp-1",
      compositionDigest: "comp-1",
      freshness: { status: "current" as const, staleMembers: [] as const },
      members: [],
      documents: [
        {
          order: 0,
          source: "claude-md",
          sourcePath: "CLAUDE.md",
          contentHash: "a".repeat(64),
          originalBytes: 120,
          bytes: 120,
          state: "included" as const,
        },
        {
          order: 1,
          source: "project-map",
          sourcePath: "(project-map)",
          contentHash: "b".repeat(64),
          originalBytes: 300,
          bytes: 64,
          state: "truncated" as const,
        },
      ],
      totalBytes: 184,
      assembledPromptDigest: "c".repeat(64),
      exhaustive: false,
      unmanagedSources: ["harness ambient file reads (context-isolation probe not yet run)"],
    };
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {},
      contextManifest: manifest,
    });
    // Every record + the truncation state + the digest survive intact.
    expect(output.contextManifest).toEqual(manifest);
    expect(output.contextManifest?.documents[1]?.state).toBe("truncated");
    expect(output.contextManifest?.assembledPromptDigest).toBe("c".repeat(64));
  });

  it("round-trips WITHOUT contextManifest unchanged (pre-#30 shape preserved)", () => {
    const output = parseCommandOutput("review.canvases", {
      canvases: canvasSet(),
      elementDiffs: {},
    });
    expect(output.contextManifest).toBeUndefined();
  });

  it("rejects a contextManifest with a malformed document record (positive control)", () => {
    expect(() =>
      parseCommandOutput("review.canvases", {
        canvases: canvasSet(),
        elementDiffs: {},
        contextManifest: {
          repoRecordId: "/repo",
          projectSnapshotId: "fp-1",
          compositionDigest: "comp-1",
          freshness: { status: "current", staleMembers: [] },
          members: [],
          // `state` is not one of included|truncated|dropped → must fail.
          documents: [{ order: 0, source: "x", sourcePath: "y", contentHash: "z", state: "bogus" }],
          totalBytes: 0,
          assembledPromptDigest: "d".repeat(64),
          exhaustive: false,
          unmanagedSources: [],
        },
      }),
    ).toThrow();
  });

  it("preserves a complete DEFERRED (not-assessed) blast paint across the boundary (#35)", () => {
    const canvases = canvasSet();
    canvases.decisions.overlay = [
      {
        target: "rennet:review/blast-radius",
        signal: "fan-in",
        reason: "Fan-in not assessed — the reference index is not wired into this overlay yet.",
        assessed: false,
      },
    ];
    const output = parseCommandOutput("review.canvases", { canvases, elementDiffs: {} });
    const paint = output.canvases.decisions.overlay[0];
    // `assessed:false` MUST survive — stripping it flips the deferred paint to "looks
    // assessed", the exact false-clear the not-assessed chips exist to prevent.
    expect(paint?.assessed).toBe(false);
    expect(paint?.signal).toBe("fan-in");
    expect(paint?.reason).toContain("not assessed");
  });
});
