import { describe, expect, it } from "vitest";
import {
  ADJUDICATION_CORPUS,
  type AdjudicationOutcome,
  scoreAdjudicationCalibration,
} from "./adjudication-corpus";

// The seeded ground-truth corpus (#41): Rennet-authored SYNTHETIC diffs only, each
// with a known verdict and claim class, expressible as an offered manifest so the
// same finding + adjudication machinery runs over it unmodified. The scorer is a pure
// function comparing raw overlap vs explicit adjudication against the known truth.

describe("ADJUDICATION_CORPUS shape (#41)", () => {
  it("has ~10 items, each with a claim class, a known truth, and an offered manifest", () => {
    expect(ADJUDICATION_CORPUS.length).toBeGreaterThanOrEqual(8);
    for (const item of ADJUDICATION_CORPUS) {
      expect(item.id).toBeTruthy();
      expect(["planted-bug", "clean"]).toContain(item.truth);
      expect(item.claimClass).toBeTruthy();
      // Offered-manifest-shaped synthetic diff.
      expect(Array.isArray(item.manifest.occurrences)).toBe(true);
      expect(item.manifest.occurrences.length).toBeGreaterThan(0);
      expect(Array.isArray(item.manifest.lineage)).toBe(true);
    }
  });

  it("planted items carry their planted anchor and summary; clean items do not", () => {
    for (const item of ADJUDICATION_CORPUS) {
      if (item.truth === "planted-bug") {
        expect(item.plantedSummary).toBeTruthy();
        expect(item.plantedAnchor).toBeTruthy();
      } else {
        expect(item.plantedSummary).toBeUndefined();
      }
    }
  });

  it("has at least one clean control for every claim class present", () => {
    const classes = new Set(ADJUDICATION_CORPUS.map((i) => i.claimClass));
    for (const cls of classes) {
      const hasClean = ADJUDICATION_CORPUS.some(
        (i) => i.claimClass === cls && i.truth === "clean",
      );
      expect(hasClean, `class ${cls} needs a clean control`).toBe(true);
    }
  });

  it("ids are unique (a corpus item is one committed fixture)", () => {
    const ids = ADJUDICATION_CORPUS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("scoreAdjudicationCalibration (#41) — pure", () => {
  const items = ADJUDICATION_CORPUS;

  it("is pure: same inputs, same output", () => {
    const outcomes: AdjudicationOutcome[] = items.map((i) => ({
      id: i.id,
      overlapFlagged: i.truth === "planted-bug",
    }));
    expect(scoreAdjudicationCalibration(items, outcomes)).toEqual(
      scoreAdjudicationCalibration(items, outcomes),
    );
  });

  it("credits adjudication when it CORRECTS a wrong solo (beats overlap)", () => {
    // A clean item that overlap wrongly flagged (a solo false positive). Overlap is
    // wrong; adjudication `contradicted` gets it right.
    const clean = items.find((i) => i.truth === "clean");
    if (!clean) throw new Error("expected a clean control item");
    const outcomes: AdjudicationOutcome[] = [
      { id: clean.id, overlapFlagged: true, adjudicatedVerdict: "contradicted" },
    ];
    const table = scoreAdjudicationCalibration([clean], outcomes);
    const row = table.find((r) => r.claimClass === clean.claimClass);
    if (!row) throw new Error("expected a class row");
    expect(row.overlapCorrect).toBe(0);
    expect(row.adjudicationCorrect).toBe(1);
  });

  it("does not credit adjudication when it stays insufficient (no improvement over overlap)", () => {
    const clean = items.find((i) => i.truth === "clean");
    if (!clean) throw new Error("expected a clean control item");
    const outcomes: AdjudicationOutcome[] = [
      { id: clean.id, overlapFlagged: true, adjudicatedVerdict: "insufficient" },
    ];
    const table = scoreAdjudicationCalibration([clean], outcomes);
    const row = table.find((r) => r.claimClass === clean.claimClass);
    if (!row) throw new Error("expected a class row");
    // Insufficient falls back to overlap's (wrong) answer — no correction.
    expect(row.overlapCorrect).toBe(0);
    expect(row.adjudicationCorrect).toBe(0);
  });

  it("credits both methods when overlap already had a planted bug right and adjudication supports it", () => {
    const planted = items.find((i) => i.truth === "planted-bug");
    if (!planted) throw new Error("expected a planted item");
    const outcomes: AdjudicationOutcome[] = [
      { id: planted.id, overlapFlagged: true, adjudicatedVerdict: "supported" },
    ];
    const table = scoreAdjudicationCalibration([planted], outcomes);
    const row = table.find((r) => r.claimClass === planted.claimClass);
    if (!row) throw new Error("expected a class row");
    expect(row.overlapCorrect).toBe(1);
    expect(row.adjudicationCorrect).toBe(1);
    expect(row.items).toBe(1);
  });
});
