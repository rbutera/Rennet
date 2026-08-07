import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { CANVAS_OPS_TOOLS, CANVAS_OPS_VERSION } from "./canvas-ops";
import {
  assemblePrimer,
  type CanvasStateSummary,
  PRIMER_MAX_BYTES,
  PRIMER_VERSION,
  PROTOCOL_CARD,
  PROTOCOL_CARD_VERSION,
  type PrimerInputs,
  type RepoFreshness,
  toolIndexFromSurface,
} from "./orchestrator-primer";

// A full-review fixture: five canvases (every angle), a decisions canvas with
// many decisions and partial coverage, and the live tool index.
function fullReviewInputs(): PrimerInputs {
  const canvasState: CanvasStateSummary[] = CANVAS_ANGLES.map((angle, index) => ({
    angle,
    canvasId: `cv_${angle}`,
    elements: angle === "decisions" ? 240 : 12 + index,
    cohorts: angle === "decisions" ? 18 : 0,
    residue: index,
    coverage: {
      paths: 40,
      dispositioned: 25,
      unread: 15,
      approved: 20,
      requestChanged: 5,
    },
  }));
  const freshness: RepoFreshness[] = [
    { repoId: "app", snapshotId: "snap_app_01", verdict: "current" },
    { repoId: "shared", snapshotId: "snap_shared_04", verdict: "stale" },
  ];
  return {
    identity: {
      reviewId: "rv_1",
      patchsetId: "ps_03",
      lineage: "delta re-review of ps_02; 14 of 19 carried approved",
      mode: "someone-elses-pr",
    },
    freshness,
    canvasState,
    toolIndex: toolIndexFromSurface(),
    runLedger: {
      fleetTasks: 9,
      admitted: 41,
      rejected: 3,
      budgetSpent: 120,
      budgetRemaining: 80,
    },
  };
}

describe("assemblePrimer", () => {
  it("assembles a full-review primer within the 4 KB budget", () => {
    const manifest = assemblePrimer(fullReviewInputs());
    expect(manifest.bytes).toBeLessThanOrEqual(PRIMER_MAX_BYTES);
    expect(manifest.version).toBe(PRIMER_VERSION);
    expect(manifest.surfaceVersion).toBe(CANVAS_OPS_VERSION);
    // The byte count is the UTF-8 length of the text, not the char count.
    expect(manifest.bytes).toBe(new TextEncoder().encode(manifest.text).length);
  });

  it("answers 'where are we / what have I not looked at' from B3 with no tool call", () => {
    const manifest = assemblePrimer(fullReviewInputs());
    // B3 states, per canvas, the unread and disposition-coverage counts — the
    // orientation question is answerable from the primer text alone.
    for (const row of manifest.sections.canvasState) {
      const line = manifest.text
        .split("\n")
        .find((l) => l.includes(row.canvasId) && l.includes("unread"));
      expect(line, `B3 line for ${row.canvasId}`).toBeDefined();
      expect(line).toContain(`${row.coverage.unread} unread`);
      expect(line).toContain(`${row.coverage.dispositioned}/${row.coverage.paths} dispositioned`);
    }
  });

  it("keeps B3 count-level: the decision COUNT is present, the bodies are not inlined", () => {
    const manifest = assemblePrimer(fullReviewInputs());
    const decisions = manifest.sections.canvasState.find((c) => c.angle === "decisions");
    expect(decisions).toBeDefined();
    // The count appears...
    expect(manifest.text).toContain("240 elements");
    // ...and no decision body/title marker is inlined (the decisions list is
    // reachable via the tool surface, never dumped into the primer).
    expect(manifest.text).not.toContain("decision.record");
    expect(manifest.text).not.toContain("DecisionRecordElement");
  });

  it("is deterministic: same state → identical bytes and digest", () => {
    const a = assemblePrimer(fullReviewInputs());
    const b = assemblePrimer(fullReviewInputs());
    expect(b.text).toBe(a.text);
    expect(b.bytes).toBe(a.bytes);
    expect(b.digest).toBe(a.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order-independent: shuffled freshness/canvas inputs assemble identically", () => {
    const base = fullReviewInputs();
    const shuffled: PrimerInputs = {
      ...base,
      freshness: [...base.freshness].reverse(),
      canvasState: [...base.canvasState].reverse(),
    };
    expect(assemblePrimer(shuffled).digest).toBe(assemblePrimer(base).digest);
  });

  it("carries the versioned protocol card byte-for-byte", () => {
    const manifest = assemblePrimer(fullReviewInputs());
    expect(manifest.sections.card).toBe(PROTOCOL_CARD);
    expect(manifest.cardVersion).toBe(PROTOCOL_CARD_VERSION);
    expect(manifest.text).toContain(PROTOCOL_CARD);
    // The card teaches the ask protocol's load-bearing rule.
    expect(PROTOCOL_CARD).toContain("Never answer about the base branch");
  });

  it("derives the tool index from the live canvasOps@2 surface, in registry order", () => {
    const index = toolIndexFromSurface();
    expect(index.map((e) => e.name)).toEqual(CANVAS_OPS_TOOLS.map((t) => t.name));
    for (const entry of index) {
      expect(entry.whenToUse.length).toBeGreaterThan(0);
    }
  });
});
