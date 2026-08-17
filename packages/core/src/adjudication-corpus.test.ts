import { describe, expect, it } from "vitest";
import {
  ADJUDICATION_CORPUS,
  type AdjudicationOutcome,
  findCalibrationClaim,
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
      expect(item.filePath).toBeTruthy();
      expect(item.claimAnchor).toBeTruthy();
      expect(item.claimSummary).toBeTruthy();
      expect(item.claimMarkerGroups.length).toBeGreaterThan(0);
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
      const hasClean = ADJUDICATION_CORPUS.some((i) => i.claimClass === cls && i.truth === "clean");
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
  const outcome = (
    item: (typeof items)[number],
    rest: Omit<AdjudicationOutcome, "id" | "claimAnchor" | "claimSummary">,
  ): AdjudicationOutcome => ({
    id: item.id,
    claimAnchor: item.claimAnchor,
    claimSummary: item.claimSummary,
    ...rest,
  });

  it("is pure: same inputs, same output", () => {
    const outcomes: AdjudicationOutcome[] = items.map((i) =>
      outcome(i, { overlapFlagged: i.truth === "planted-bug" }),
    );
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
      outcome(clean, { overlapFlagged: true, adjudicatedVerdict: "contradicted" }),
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
      outcome(clean, { overlapFlagged: true, adjudicatedVerdict: "insufficient" }),
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
      outcome(planted, { overlapFlagged: true, adjudicatedVerdict: "supported" }),
    ];
    const table = scoreAdjudicationCalibration([planted], outcomes);
    const row = table.find((r) => r.claimClass === planted.claimClass);
    if (!row) throw new Error("expected a class row");
    expect(row.overlapCorrect).toBe(1);
    expect(row.adjudicationCorrect).toBe(1);
    expect(row.items).toBe(1);
  });

  it("rejects missing, duplicate, and unknown outcomes before scoring", () => {
    const [first, second] = items;
    if (!first || !second) throw new Error("expected corpus items");
    const firstOutcome = outcome(first, { overlapFlagged: false });
    const secondOutcome = outcome(second, { overlapFlagged: false });

    expect(() => scoreAdjudicationCalibration([first, second], [firstOutcome])).toThrow(
      /Missing calibration outcomes/,
    );
    expect(() => scoreAdjudicationCalibration([first], [firstOutcome, firstOutcome])).toThrow(
      /Duplicate calibration outcome/,
    );
    expect(() =>
      scoreAdjudicationCalibration([first], [{ ...secondOutcome, id: "unknown" }]),
    ).toThrow(/Unknown calibration outcome/);
  });

  it("rejects an outcome joined to the wrong seeded claim", () => {
    const item = items[0];
    if (!item) throw new Error("expected corpus item");
    expect(() =>
      scoreAdjudicationCalibration(
        [item],
        [{ ...outcome(item, { overlapFlagged: true }), claimSummary: "another claim" }],
      ),
    ).toThrow(/claim mismatch/);
  });
});

describe("findCalibrationClaim (#41)", () => {
  const item = ADJUDICATION_CORPUS[0];
  if (!item) throw new Error("expected corpus item");
  const finding = (findingId: string, summary: string) => ({
    findingId,
    anchor: item.claimAnchor,
    summary,
    severity: "high" as const,
    agreement: { kind: "concur" as const, agree: 2, total: 2 },
  });

  it("selects the seeded claim, not an unrelated finding at the same anchor", () => {
    const selected = findCalibrationClaim(item, [
      finding("noise", "prefer a clearer variable name"),
      finding("claim", "items.length creates an off-by-one read"),
    ]);
    expect(selected?.findingId).toBe("claim");
  });

  it("rejects ambiguous multiple matches", () => {
    expect(() =>
      findCalibrationClaim(item, [
        finding("a", "items.length causes an off-by-one read"),
        finding("b", "the loop overruns at items.length"),
      ]),
    ).toThrow(/Ambiguous calibration claim/);
  });
});
