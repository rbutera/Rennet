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
    // context.ask (issue #15) carries a dedicated one-liner so the tool index matches
    // the standing PROTOCOL_CARD promise, not the description's first sentence.
    const ask = index.find((e) => e.name === "context.ask");
    expect(ask?.whenToUse).toContain("QUESTION");
    expect(ask?.whenToUse).toContain("unanswered");
  });

  it("ENFORCES the ≤4 KB ceiling: an oversized state throws rather than assembling a fat primer", () => {
    // Enough canvases + repos that the map overruns 4 KB (counts-only or not, the
    // ceiling is a hard boundary). Before enforcement this assembled a ~13 KB
    // "lean" primer silently.
    const oversized: PrimerInputs = {
      identity: { reviewId: "rv_big", patchsetId: "ps_big" },
      freshness: Array.from({ length: 40 }, (_, i) => ({
        repoId: `repo_with_a_fairly_long_identifier_${i}`,
        snapshotId: `snapshot_${i}`,
        verdict: "current" as const,
      })),
      canvasState: Array.from({ length: 16 }, (_, r) => r).flatMap((r) =>
        CANVAS_ANGLES.map((angle, i) => ({
          angle,
          canvasId: `cv_long_canvas_identifier_number_${r}_${i}`,
          elements: 999,
          cohorts: 88,
          residue: 7,
          coverage: {
            paths: 400,
            dispositioned: 250,
            unread: 150,
            approved: 200,
            requestChanged: 50,
          },
        })),
      ),
      toolIndex: toolIndexFromSurface(),
      runLedger: { fleetTasks: 9, admitted: 41, rejected: 3 },
    };
    expect(() => assemblePrimer(oversized)).toThrow(/ceiling|4096/);
  });

  it("renders B1 workspace/repo when the identity carries them", () => {
    const base = fullReviewInputs();
    const manifest = assemblePrimer({
      ...base,
      identity: { ...base.identity, workspace: "acme-monorepo", repo: "app" },
    });
    expect(manifest.text).toContain("workspace acme-monorepo");
    expect(manifest.text).toContain("repo app");
    // workspace/repo lead the B1 identity line, ahead of the reviewId.
    const b1 = manifest.text.slice(0, manifest.text.indexOf("review rv_1"));
    expect(b1).toContain("workspace acme-monorepo");
    expect(b1).toContain("repo app");
  });

  it("orders freshness by CODE UNITS, not locale (determinism across ICU versions)", () => {
    // localeCompare('a','B') is negative in en (a first); code-unit puts 'B'(66)
    // before 'a'(97). The digest is provenance, so ordering must be code-unit.
    const base = fullReviewInputs();
    const manifest = assemblePrimer({
      ...base,
      freshness: [
        { repoId: "a", snapshotId: "snap_a", verdict: "current" },
        { repoId: "B", snapshotId: "snap_B", verdict: "current" },
      ],
    });
    const lines = manifest.text.split("\n");
    const iB = lines.findIndex((l) => l.startsWith("- B:"));
    const iA = lines.findIndex((l) => l.startsWith("- a:"));
    expect(iB).toBeGreaterThanOrEqual(0);
    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iB).toBeLessThan(iA); // 'B' before 'a' — code-unit order, not locale
  });

  it("keeps B3 STRICTLY count-shaped: the decisions line is counts only, no inlined body", () => {
    const manifest = assemblePrimer(fullReviewInputs());
    const decisionsLine = manifest.text.split("\n").find((l) => l.startsWith("- decisions ("));
    expect(decisionsLine).toBeDefined();
    // A body/title inlined into B3 would break this counts-only line shape.
    expect(decisionsLine).toMatch(
      /^- decisions \(cv_decisions\): \d+ elements, \d+ cohorts, \d+ residue; coverage \d+\/\d+ dispositioned, \d+ unread, \d+ approved, \d+ request-change$/,
    );
  });
});
