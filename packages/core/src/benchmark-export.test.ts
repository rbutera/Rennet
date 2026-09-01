import type { BenchmarkProvenance, BenchmarkRun } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { benchmarkExportText, buildBenchmarkExport } from "./benchmark-export";

const provenance: BenchmarkProvenance = {
  exportedAt: "2026-09-01T10:00:00.000Z",
  machine: "darwin arm64, 12 cores",
  revision: "abc123",
};

function generation(
  id: string,
  harnesses: readonly ("claude-code" | "codex")[],
  draftMs: number,
): BenchmarkRun {
  return {
    version: 1,
    id,
    kind: "generation",
    subject: { label: id, sessionId: id, generationId: `${id}-g` },
    startedAtMs: 1_000,
    durationMs: draftMs + 100,
    outcome: "complete",
    stages: harnesses.map((harness, index) => ({
      stage: "lens-draft" as const,
      lens: "flagged" as const,
      startedAtMs: 1_000 + index,
      durationMs: draftMs,
      harness,
      model: harness === "codex" ? "gpt-5" : "opus",
    })),
  };
}

function mapRun(id: string, treeMs: number): BenchmarkRun {
  return {
    version: 1,
    id,
    kind: "repo-map",
    subject: { label: "rennet", repoKey: "rennet", revision: "deadbeef" },
    startedAtMs: 500,
    durationMs: treeMs + 20,
    outcome: "complete",
    stages: [
      { stage: "tree", startedAtMs: 500, durationMs: treeMs },
      { stage: "total", startedAtMs: 500, durationMs: treeMs + 20 },
    ],
  };
}

describe("buildBenchmarkExport — deterministic by construction", () => {
  it("produces byte-identical output for the same runs in a different order", () => {
    const runs = [
      generation("a", ["claude-code"], 200),
      mapRun("m1", 40),
      generation("b", ["claude-code", "codex"], 300),
      generation("c", ["codex"], 250),
      mapRun("m2", 60),
    ];
    const forwards = benchmarkExportText(buildBenchmarkExport({ runs, provenance }));
    const backwards = benchmarkExportText(
      buildBenchmarkExport({ runs: [...runs].reverse(), provenance }),
    );
    expect(forwards).toBe(backwards);
    // Positive control on the determinism claim: a genuinely different measurement must
    // move the bytes, or "identical output" would only be proving the function is constant.
    const changed = benchmarkExportText(
      buildBenchmarkExport({
        runs: [...runs.slice(0, 4), mapRun("m2", 61)],
        provenance,
      }),
    );
    expect(changed).not.toBe(forwards);
  });

  it("re-exporting the same archive twice yields the same bytes", () => {
    const runs = [generation("a", ["claude-code"], 200)];
    expect(benchmarkExportText(buildBenchmarkExport({ runs, provenance }))).toBe(
      benchmarkExportText(buildBenchmarkExport({ runs, provenance })),
    );
  });
});

describe("buildBenchmarkExport — modes are split, never merged", () => {
  it("keeps each derived configuration in its own row", () => {
    const exported = buildBenchmarkExport({
      runs: [
        generation("a", ["claude-code"], 200),
        generation("b", ["claude-code", "codex"], 1000),
        generation("c", ["codex"], 400),
      ],
      provenance,
    });
    const draftRows = exported.stages.filter((row) => row.stage === "lens-draft");
    expect(draftRows.map((row) => row.mode)).toEqual(["dual-model", "claude-only", "codex-only"]);
    // The council run's 1000 ms never contaminates the Claude-only median. If these ever
    // merged, the claude-only median would move off 200.
    expect(draftRows.find((row) => row.mode === "claude-only")?.medianMs).toBe(200);
    expect(draftRows.find((row) => row.mode === "codex-only")?.medianMs).toBe(400);
  });

  it("counts a failed run rather than dropping it", () => {
    const exported = buildBenchmarkExport({ runs: [failedGeneration(900)], provenance });
    const group = exported.runs.find((row) => row.kind === "generation");
    expect(group?.count).toBe(1);
    expect(group?.failed).toBe(1);
    expect(group?.complete).toBe(0);
    // No stages recorded, so no stage row is invented for it.
    expect(exported.stages).toEqual([]);
    // …and no latency, because nothing in the group finished. `0` would read as an
    // instantaneous pipeline rather than as one that never got to the end.
    expect(group?.medianMs).toBeUndefined();
  });
});

function failedGeneration(durationMs: number, stages: BenchmarkRun["stages"] = []): BenchmarkRun {
  return {
    version: 1,
    id: `f-${durationMs}`,
    kind: "generation",
    subject: { label: "f", sessionId: "f", generationId: `f-${durationMs}` },
    startedAtMs: 0,
    durationMs,
    outcome: "failed",
    failure: "the report gate did not settle",
    stages,
  };
}

describe("the median, and its stated rounding (#731 N8)", () => {
  it("takes the MIDPOINT of the two middles on an even sample, truncated", () => {
    // The lower middle is a different statistic wearing the name: it would report this
    // pair as 100 rather than 500, and a two-run sample is the common case here.
    const exported = buildBenchmarkExport({
      runs: [mapRun("m1", 100), mapRun("m2", 900)],
      provenance,
    });
    const tree = exported.stages.find((row) => row.stage === "tree");
    expect(tree?.samples).toBe(2);
    expect(tree?.medianMs).toBe(500);

    // Truncation, stated on the function and asserted here: (100 + 101) / 2 = 100.5 → 100.
    const odd = buildBenchmarkExport({
      runs: [mapRun("m1", 100), mapRun("m2", 101)],
      provenance,
    });
    expect(odd.stages.find((row) => row.stage === "tree")?.medianMs).toBe(100);
  });

  it("still takes the single middle on an odd sample", () => {
    const exported = buildBenchmarkExport({
      runs: [mapRun("m1", 10), mapRun("m2", 20), mapRun("m3", 900)],
      provenance,
    });
    expect(exported.stages.find((row) => row.stage === "tree")?.medianMs).toBe(20);
  });
});

describe("latency is never mixed across outcomes (#731 N8)", () => {
  it("splits stage rows by the outcome of the run they came from", () => {
    const exported = buildBenchmarkExport({
      runs: [
        generation("a", ["claude-code"], 200),
        failedGeneration(90, [
          {
            stage: "lens-draft",
            lens: "flagged",
            startedAtMs: 1_000,
            durationMs: 20_000,
            harness: "claude-code",
            model: "opus",
          },
        ]),
      ],
      provenance,
    });
    const drafts = exported.stages.filter((row) => row.stage === "lens-draft");
    expect(drafts.map((row) => row.outcome)).toEqual(["complete", "failed"]);
    // The 20 s of a lane that then died never moves the completed lane's median off 200.
    // If these merged, the complete row would read 10100.
    expect(drafts.find((row) => row.outcome === "complete")?.medianMs).toBe(200);
    expect(drafts.find((row) => row.outcome === "failed")?.medianMs).toBe(20_000);
  });

  it("computes the run median over COMPLETE runs only, and counts the rest beside it", () => {
    const exported = buildBenchmarkExport({
      runs: [
        generation("a", ["claude-code"], 200),
        generation("b", ["claude-code"], 400),
        // Same DERIVED mode as the two above — it named Claude before it died — so it
        // lands in the same group and the split has to be the outcome, not the mode.
        failedGeneration(1_000_000, [
          {
            stage: "lens-draft",
            lens: "flagged",
            startedAtMs: 1_000,
            durationMs: 999_000,
            harness: "claude-code",
            model: "opus",
          },
        ]),
      ],
      provenance,
    });
    const group = exported.runs.find((row) => row.kind === "generation");
    expect(group?.count).toBe(3);
    expect(group?.complete).toBe(2);
    expect(group?.failed).toBe(1);
    // 400 = midpoint of 300 and 500 (each generation's durationMs is draftMs + 100). The
    // million-millisecond failure is counted and never averaged in — mixing it would put
    // this median above 500.
    expect(group?.medianMs).toBe(400);
  });
});

describe("a run states which pipeline recorded it (#731 N7)", () => {
  it("carries the distinct producers, and says so when a run predates the field", () => {
    const exported = buildBenchmarkExport({
      runs: [
        { ...mapRun("m1", 40), producer: "cli-map" },
        { ...mapRun("m2", 50), producer: "daemon" },
        mapRun("m3", 60),
      ],
      provenance,
    });
    const group = exported.runs.find((row) => row.kind === "repo-map");
    // Sorted, so two exports of the same archive cannot differ in this field alone.
    expect(group?.producers).toEqual(["cli-map", "daemon", "unrecorded"]);
  });
});
