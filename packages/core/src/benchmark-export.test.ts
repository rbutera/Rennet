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
    const failed: BenchmarkRun = {
      version: 1,
      id: "f",
      kind: "generation",
      subject: { label: "f" },
      startedAtMs: 0,
      durationMs: 900,
      outcome: "failed",
      failure: "the report gate did not settle",
      stages: [],
    };
    const exported = buildBenchmarkExport({ runs: [failed], provenance });
    const group = exported.runs.find((row) => row.kind === "generation");
    expect(group?.count).toBe(1);
    expect(group?.failed).toBe(1);
    expect(group?.complete).toBe(0);
    // No stages recorded, so no stage row is invented for it.
    expect(exported.stages).toEqual([]);
  });
});
