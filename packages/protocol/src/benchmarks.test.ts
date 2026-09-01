import { describe, expect, it } from "vitest";
import {
  type BenchmarkStage,
  benchmarkDualReview,
  benchmarkLensTotals,
  benchmarkRunSchema,
  benchmarkSpan,
  benchmarkStageSchema,
  deriveBenchmarkMode,
} from "./benchmarks";

function stage(over: Partial<BenchmarkStage> & Pick<BenchmarkStage, "stage">): BenchmarkStage {
  return { startedAtMs: 1000, durationMs: 10, ...over } as BenchmarkStage;
}

describe("benchmark stage records — the lens discrimination is on the RECORD", () => {
  it("refuses a lane-scoped stage that forgot its lens", () => {
    const parsed = benchmarkStageSchema.safeParse({
      stage: "lens-draft",
      startedAtMs: 1,
      durationMs: 1,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("must name its lens");
  });

  it("refuses a run-wide stage that carries one", () => {
    const parsed = benchmarkStageSchema.safeParse({
      stage: "coverage",
      lens: "flagged",
      startedAtMs: 1,
      durationMs: 1,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("must not name a lens");
  });

  it("refuses a stage that belongs to the other kind of run", () => {
    // A repo-map run carrying `lens-draft` would be a deterministic build claiming a
    // provider drafted for it. The kind decides the vocabulary.
    const parsed = benchmarkRunSchema.safeParse({
      version: 1,
      id: "r1",
      kind: "repo-map",
      subject: { label: "rennet" },
      startedAtMs: 0,
      durationMs: 10,
      outcome: "complete",
      stages: [{ stage: "lens-draft", lens: "flagged", startedAtMs: 0, durationMs: 5 }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("cannot carry the lens-draft stage");
  });

  it("accepts a failed run — a run that died is a measurement, not an absence", () => {
    const parsed = benchmarkRunSchema.safeParse({
      version: 1,
      id: "r2",
      kind: "generation",
      subject: { label: "s1", sessionId: "s1", generationId: "g1" },
      startedAtMs: 0,
      durationMs: 900,
      outcome: "failed",
      failure: "round-report seat: classification turn did not emit",
      stages: [{ stage: "report", startedAtMs: 0, durationMs: 800 }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.outcome).toBe("failed");
  });
});

describe("deriveBenchmarkMode — read off the stages, never off a setting", () => {
  it("names dual-model from the TWO per-seat draft records of one lane", () => {
    // The per-seat shape is the whole reason this is derivable: a single merged record
    // for a dual Flagged lane could only have named one of the two harnesses.
    const stages = [
      stage({ stage: "lens-draft", lens: "flagged", harness: "claude-code", model: "opus" }),
      stage({ stage: "lens-draft", lens: "flagged", harness: "codex", model: "gpt-5" }),
    ];
    expect(deriveBenchmarkMode(stages)).toBe("dual-model");
  });

  it("counts the report gate's executor too, so a mixed run is not relabelled", () => {
    // Scoping the harness set to drafting would call this Claude-only, which is false:
    // Codex ran the classification turn.
    const stages = [
      stage({ stage: "report-classification", harness: "codex", model: "gpt-5" }),
      stage({ stage: "lens-draft", lens: "sequence", harness: "claude-code", model: "opus" }),
    ];
    expect(deriveBenchmarkMode(stages)).toBe("dual-model");
  });

  it("names each single-provider install and the unattributed deterministic run", () => {
    expect(
      deriveBenchmarkMode([stage({ stage: "lens-draft", lens: "noise", harness: "codex" })]),
    ).toBe("codex-only");
    expect(
      deriveBenchmarkMode([stage({ stage: "lens-draft", lens: "noise", harness: "claude-code" })]),
    ).toBe("claude-only");
    expect(deriveBenchmarkMode([stage({ stage: "tree" })])).toBe("unattributed");
    expect(deriveBenchmarkMode([])).toBe("unattributed");
  });
});

describe("spans over the per-seat records", () => {
  it("takes a lane's total as min-start to max-end across its seats", () => {
    const stages = [
      stage({ stage: "lens-draft", lens: "flagged", startedAtMs: 100, durationMs: 400 }),
      stage({ stage: "lens-draft", lens: "flagged", startedAtMs: 150, durationMs: 600 }),
      stage({ stage: "lens-post-process", lens: "flagged", startedAtMs: 760, durationMs: 40 }),
    ];
    const [lane] = benchmarkLensTotals(stages);
    expect(lane?.lens).toBe("flagged");
    expect(lane?.startedAtMs).toBe(100);
    // 100 → 800 (the post-process end), not 400+600+40: the seats OVERLAP, and summing
    // them would report 1040 ms of wait that nobody waited.
    expect(lane?.durationMs).toBe(700);
  });

  it("reports a dual review only when the lane genuinely ran two seats", () => {
    const dual = [
      stage({ stage: "lens-draft", lens: "flagged", harness: "claude-code", startedAtMs: 10 }),
      stage({ stage: "lens-draft", lens: "flagged", harness: "codex", startedAtMs: 20 }),
    ];
    expect(benchmarkDualReview(dual, "flagged")?.harnesses).toEqual(["claude-code", "codex"]);
    // One seat is a lane that had one seat, not a lane whose review went unmeasured.
    expect(benchmarkDualReview([dual[0] as BenchmarkStage], "flagged")).toBeUndefined();
  });

  it("has no span over nothing", () => {
    expect(benchmarkSpan([])).toBeUndefined();
  });
});
