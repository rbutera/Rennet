import { describe, expect, it } from "vitest";
import { classifyLineage, measure, renderMeasurementTables } from "./lineage-matcher";
import { LINEAGE_FIXTURES } from "./lineage-matcher-fixtures";

// The spike measurement, run as a reddening guard. The auto-carry precision bar
// and the zero-wrong-carries invariant are the load-bearing claims the verdict
// doc (`docs/Rennet Lineage Matcher Verdict.md`) rests on — if the matcher ever
// regresses on the fixture corpus, this test fails rather than the doc quietly
// going stale on a safety number.

describe("lineage matcher measurement", () => {
  const report = measure(LINEAGE_FIXTURES);

  it("carries read state onto the WRONG code zero times (the product's worst failure)", () => {
    expect(report.wrongCarries).toBe(0);
  });

  it("meets the auto-carry precision bar (~100%) with full recall on this corpus", () => {
    expect(report.autoCarry.precision).toBe(1);
    expect(report.autoCarry.recall).toBe(1);
    // Non-vacuous: there really are carryable priors being measured.
    expect(report.autoCarry.support).toBe(25);
  });

  it("scores every auto-carry class (exact, move) at 100% precision", () => {
    const exact = report.perClass.get("exact");
    const move = report.perClass.get("move");
    expect(exact?.precision).toBe(1);
    expect(move?.precision).toBe(1);
    // And they are actually exercised (support > 0), so the 100% is not vacuous.
    expect(exact?.support).toBeGreaterThan(0);
    expect(move?.support).toBeGreaterThan(0);
  });

  it("classifies every fixture prior correctly against ground truth (no misses)", () => {
    const misses: string[] = [];
    for (const fixture of LINEAGE_FIXTURES) {
      const result = classifyLineage(fixture.prior, fixture.successor);
      const byFrom = new Map(result.classifications.map((c) => [c.fromId, c]));
      for (const truth of fixture.truth) {
        const pred = byFrom.get(truth.fromId);
        const targetOk =
          truth.lineage === "split"
            ? JSON.stringify([...(pred?.toIds ?? [])].sort()) ===
              JSON.stringify([...(truth.toIds ?? [])].sort())
            : truth.lineage === "terminated" || truth.lineage === "ambiguous"
              ? true
              : pred?.toId === truth.toId;
        if (!pred || pred.lineage !== truth.lineage || !targetOk) {
          misses.push(
            `${fixture.name}/${truth.fromId}: want ${truth.lineage}, got ${pred?.lineage}`,
          );
        }
      }
      // `added` correctness only where the fixture declares it (an ambiguous
      // fixture's leftover copy is itself ambiguous, so it is left unasserted).
      if (fixture.addedTruth) {
        expect([...result.added].sort()).toEqual([...fixture.addedTruth].sort());
      }
    }
    expect(misses).toEqual([]);
  });

  it("every class present in the corpus is measured (coverage of all seven edges)", () => {
    for (const lineage of [
      "exact",
      "move",
      "one-to-one",
      "split",
      "merge",
      "ambiguous",
      "terminated",
    ] as const) {
      expect(report.perClass.get(lineage)?.support).toBeGreaterThan(0);
    }
  });

  it("renders the committed verdict tables verbatim (doc cannot silently drift)", () => {
    // This block is the exact markdown committed to docs/Rennet Lineage Matcher
    // Verdict.md. Regenerate the doc from this string if the corpus changes.
    expect(renderMeasurementTables(report)).toBe(
      [
        "| Class | Support | TP | FP | FN | Precision | Recall |",
        "|---|---|---|---|---|---|---|",
        "| `exact` | 21 | 21 | 0 | 0 | 100.0% | 100.0% |",
        "| `move` | 4 | 4 | 0 | 0 | 100.0% | 100.0% |",
        "| `one-to-one` | 6 | 6 | 0 | 0 | 100.0% | 100.0% |",
        "| `split` | 1 | 1 | 0 | 0 | 100.0% | 100.0% |",
        "| `merge` | 2 | 2 | 0 | 0 | 100.0% | 100.0% |",
        "| `ambiguous` | 1 | 1 | 0 | 0 | 100.0% | 100.0% |",
        "| `terminated` | 2 | 2 | 0 | 0 | 100.0% | 100.0% |",
        "",
        "**Auto-carry aggregate (exact + move):** precision 100.0%, recall 100.0% over 25 carryable priors. **Wrong carries: 0** (must be 0).",
      ].join("\n"),
    );
  });
});
