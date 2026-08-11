import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { autoCarries, classifyLineage, measure, renderMeasurementTables } from "./lineage-matcher";
import { LINEAGE_FIXTURES } from "./lineage-matcher-fixtures";

// The spike measurement, run as a reddening guard. The zero-wrong-carries
// invariant and the move-exclusion evidence are the load-bearing claims the
// verdict doc (`docs/Rennet Lineage Matcher Verdict.md`) rests on — if the matcher
// regresses on the corpus, this fails rather than the doc going stale on a safety
// number. The corpus INCLUDES the adversarial cases that disproved `move`.

describe("lineage matcher measurement", () => {
  const report = measure(LINEAGE_FIXTURES);

  it("carries read state onto the WRONG code zero times under the live policy", () => {
    // The product's worst failure. exact-only, and exact never mis-carries on the
    // corpus (including the same-path-rotated adversarial case, which fails closed).
    expect(report.wrongCarries).toBe(0);
  });

  it("the auto-carry class is EXACT only, and exact is never a false positive", () => {
    expect(autoCarries("exact")).toBe(true);
    expect(autoCarries("move")).toBe(false);
    const exact = report.perClass.get("exact");
    expect(exact?.falsePositive).toBe(0); // exact is never wrong on the corpus
    expect(exact?.support).toBeGreaterThan(0); // non-vacuous
    expect(report.autoCarry.support).toBe(21);
    expect(report.autoCarry.passRate).toBe(1);
  });

  it("excludes `move` on MEASURED evidence: enabling it would carry onto wrong code", () => {
    // The counterfactual is the reason move is out — not an assumption. The
    // delete-plus-copy and decoy fixtures produce confident wrong moves.
    expect(report.moveCounterfactualWrongCarries).toBe(2);
    expect(report.moveCorrect).toBe(4);
    // And it is genuinely unreliable on the corpus (not a 100% we chose to drop).
    expect(report.perClass.get("move")?.passRate).toBeLessThan(1);
  });

  it("the exact-hole guard: identical twins at one path with rotated context fail closed", () => {
    // Without the (body,path)-uniqueness guard these were confident `exact`s that
    // auto-carry — six wrong carries. The guard makes them ambiguous.
    const fixture = LINEAGE_FIXTURES.find((f) => f.name === "same-path-rotated-context");
    if (!fixture) throw new Error("adversarial fixture missing");
    const result = classifyLineage(fixture.prior, fixture.successor);
    expect(result.classifications.every((c) => c.lineage === "ambiguous")).toBe(true);
    expect(result.classifications.every((c) => !autoCarries(c.lineage))).toBe(true);
  });

  it("the delete-plus-copy adversarial case is a confident MOVE (would wrongly carry if enabled)", () => {
    const fixture = LINEAGE_FIXTURES.find((f) => f.name === "delete-plus-copy");
    if (!fixture) throw new Error("adversarial fixture missing");
    const c = classifyLineage(fixture.prior, fixture.successor).classifications[0];
    expect(c?.lineage).toBe("move"); // the truth is `terminated` — the matcher cannot tell
  });

  it("every lineage class present in the corpus is measured (all seven edges)", () => {
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

  it("the committed verdict doc contains the CURRENT measured tables verbatim", () => {
    // Low 5: read the table out of the DOCUMENT, so editing the doc's numbers (or
    // the measurement drifting from them) reddens — the anti-drift check that used
    // to compare generated output to another hard-coded string.
    const docPath = fileURLToPath(
      new URL("../../../docs/Rennet Lineage Matcher Verdict.md", import.meta.url),
    );
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toContain(renderMeasurementTables(report));
  });
});
