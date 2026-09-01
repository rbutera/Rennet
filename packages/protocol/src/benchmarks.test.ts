import { describe, expect, it } from "vitest";
import {
  type BenchmarkRun,
  type BenchmarkStage,
  benchmarkDualReview,
  benchmarkLensTotals,
  benchmarkRunSchema,
  benchmarkSpan,
  benchmarkStageSchema,
  deriveBenchmarkMode,
  GENERATION_STAGES,
} from "./benchmarks";
import { GenerationPhaseSchema } from "./session/model";

/** A well-formed run of each kind, so a test can change ONE thing and see it refused. */
function mapRun(over: Partial<BenchmarkRun> = {}): unknown {
  return {
    version: 1,
    id: "m1",
    kind: "repo-map",
    subject: { label: "rennet", repoKey: "rennet", revision: "deadbeef" },
    startedAtMs: 0,
    durationMs: 10,
    outcome: "complete",
    stages: [{ stage: "tree", startedAtMs: 0, durationMs: 5 }],
    ...over,
  };
}

function generationRun(over: Partial<BenchmarkRun> = {}): unknown {
  return {
    version: 1,
    id: "g1:0",
    kind: "generation",
    subject: { label: "s1", sessionId: "s1", generationId: "g1" },
    attempt: 0,
    startedAtMs: 0,
    durationMs: 10,
    outcome: "complete",
    stages: [{ stage: "report", startedAtMs: 0, durationMs: 5, harness: "codex", model: "gpt-5" }],
    ...over,
  };
}

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
    const parsed = benchmarkRunSchema.safeParse(
      mapRun({
        stages: [
          { stage: "lens-draft", lens: "flagged", startedAtMs: 0, durationMs: 5 },
        ] as BenchmarkRun["stages"],
      }),
    );
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

describe("attribution is one fact, not two fields (#731 N5)", () => {
  it("refuses a stage that names a harness with no model, and one that names a model with no harness", () => {
    // A half-attribution reads on every surface exactly like a whole one, which is what
    // makes it worse than none: "Claude ran this" with nothing to hold the claim to.
    const noModel = benchmarkStageSchema.safeParse({
      stage: "report",
      startedAtMs: 0,
      durationMs: 1,
      harness: "claude-code",
    });
    expect(noModel.success).toBe(false);
    expect(noModel.error?.issues[0]?.message).toContain("harness AND its model");
    expect(noModel.error?.issues[0]?.path).toEqual(["model"]);

    const noHarness = benchmarkStageSchema.safeParse({
      stage: "report",
      startedAtMs: 0,
      durationMs: 1,
      model: "gpt-5",
    });
    expect(noHarness.success).toBe(false);
    expect(noHarness.error?.issues[0]?.path).toEqual(["harness"]);
  });

  it("accepts both together and neither at all", () => {
    expect(
      benchmarkStageSchema.safeParse({
        stage: "report",
        startedAtMs: 0,
        durationMs: 1,
        harness: "codex",
        model: "gpt-5",
      }).success,
    ).toBe(true);
    // A deterministic stage names neither, and that is not an omission.
    expect(
      benchmarkStageSchema.safeParse({ stage: "tree", startedAtMs: 0, durationMs: 1 }).success,
    ).toBe(true);
  });
});

describe("a repo-map run cannot claim a provider (#731 N5)", () => {
  it("refuses a harness on ANY stage of a deterministic build", () => {
    const parsed = benchmarkRunSchema.safeParse(
      mapRun({
        stages: [
          { stage: "tree", startedAtMs: 0, durationMs: 5, harness: "codex", model: "gpt-5" },
        ] as BenchmarkRun["stages"],
      }),
    );
    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some((issue) => issue.message.includes("cannot name a provider")),
    ).toBe(true);
    // The control: the SAME run without the attribution parses, so the refusal is about
    // the harness rather than about anything else in the fixture.
    expect(benchmarkRunSchema.safeParse(mapRun()).success).toBe(true);
  });

  it("still lets a generation stage name one — the rule is per kind, not global", () => {
    expect(benchmarkRunSchema.safeParse(generationRun()).success).toBe(true);
  });
});

describe("the subject a run of each kind must carry (#731 N5)", () => {
  it("refuses a repo-map run with no repoKey, and a completed one with no revision", () => {
    const noRepo = benchmarkRunSchema.safeParse(mapRun({ subject: { label: "rennet" } }));
    expect(noRepo.success).toBe(false);
    expect(
      noRepo.error?.issues.some((issue) => issue.message.includes("must name its repoKey")),
    ).toBe(true);

    const noRevision = benchmarkRunSchema.safeParse(
      mapRun({ subject: { label: "rennet", repoKey: "rennet" } }),
    );
    expect(noRevision.success).toBe(false);
    expect(noRevision.error?.issues[0]?.message).toContain("must name the revision it built");
  });

  it("lets a FAILED map run omit the revision — a build that died has none to name", () => {
    // The requirement is on `complete` alone on purpose. Demanding a revision of every map
    // run would make the failed builds unrecordable, and those are the slow ones.
    const parsed = benchmarkRunSchema.safeParse(
      mapRun({
        subject: { label: "rennet", repoKey: "rennet" },
        outcome: "failed",
        failure: "the tree walk fell over",
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses a generation with no sessionId or no generationId, and allows no roundId", () => {
    const noSession = benchmarkRunSchema.safeParse(
      generationRun({ subject: { label: "s1", generationId: "g1" } }),
    );
    expect(noSession.success).toBe(false);
    expect(noSession.error?.issues[0]?.message).toContain("must name its sessionId");

    const noGeneration = benchmarkRunSchema.safeParse(
      generationRun({ subject: { label: "s1", sessionId: "s1" } }),
    );
    expect(noGeneration.success).toBe(false);
    expect(noGeneration.error?.issues[0]?.message).toContain("must name its generationId");

    // An askless first generation has no round, and demanding one would force an invention.
    expect(benchmarkRunSchema.safeParse(generationRun()).success).toBe(true);
  });
});

describe("GENERATION_STAGES is the spine's phase list (#731 O1)", () => {
  it("contains every generation phase, and no stage the spine does not name", () => {
    // Both directions, at runtime. The `satisfies` on the declaration catches only one of
    // them: a phase added to the spine and forgotten here type-checks fine and silently
    // stops being recorded.
    const phases = [...GenerationPhaseSchema.options].sort();
    const stages = [...GENERATION_STAGES].sort();
    expect(stages).toEqual(phases);
  });
});
