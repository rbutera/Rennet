import type { CouncilAvailability, CouncilResolveContext } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_TABLES,
  JOB_CATALOGUE,
  providerHarness,
  resolveAssignment,
  scenarioFor,
} from "./model-council";

const BOTH: CouncilAvailability = { installed: ["claude-code", "codex"] };
const CLAUDE_ONLY: CouncilAvailability = { installed: ["claude-code"] };
const CODEX_ONLY: CouncilAvailability = { installed: ["codex"] };

function ctx(
  availability: CouncilAvailability,
  extra: Partial<CouncilResolveContext> = {},
): CouncilResolveContext {
  return { availability, ...extra };
}

describe("scenarioFor", () => {
  it("maps installed harness sets to the three canonical scenarios, else degraded", () => {
    expect(scenarioFor(BOTH)).toBe("both");
    expect(scenarioFor(CLAUDE_ONLY)).toBe("claude-only");
    expect(scenarioFor(CODEX_ONLY)).toBe("codex-only");
    expect(scenarioFor({ installed: [] })).toBeNull();
    // omp is ignored for scenario selection (the tables cover Claude/Codex).
    expect(scenarioFor({ installed: [] as CouncilAvailability["installed"] })).toBeNull();
  });
});

describe("the versioned job catalogue", () => {
  it("names every model-facing job with a tier, and marks the riders", () => {
    const modelFacing = Object.values(JOB_CATALOGUE).filter(
      (entry) => entry.tier !== "deterministic",
    );
    // The 21 named §2.2 jobs, plus the 3 riders and the split judgment-angle job,
    // plus M22/M24/M25/M26 — every one carries a tier.
    for (const entry of modelFacing) expect(["light", "heavy"]).toContain(entry.tier);
    expect(JOB_CATALOGUE["decision-why"]?.sessionRider).toBe(true);
    expect(JOB_CATALOGUE["decomposition-proposal"]?.sessionRider).toBe(false);
    // A deterministic-floor job exists.
    expect(JOB_CATALOGUE["route-plan-budget-gate"]?.tier).toBe("deterministic");
  });

  it("every model-facing job has an entry in all three assignment tables", () => {
    const modelFacing = Object.values(JOB_CATALOGUE)
      .filter((entry) => entry.tier !== "deterministic")
      .map((entry) => entry.jobId);
    for (const jobId of modelFacing) {
      expect(ASSIGNMENT_TABLES.both[jobId], `both:${jobId}`).toBeDefined();
      expect(ASSIGNMENT_TABLES["claude-only"][jobId], `claude:${jobId}`).toBeDefined();
      expect(ASSIGNMENT_TABLES["codex-only"][jobId], `codex:${jobId}`).toBeDefined();
    }
  });

  it("routes CI failure classification as a batched light Codex seat when both are installed", () => {
    expect(JOB_CATALOGUE["ci-failure-classification"]).toMatchObject({
      tier: "light",
      batching: "batched",
      sessionRider: false,
    });
    expect(resolveAssignment("ci-failure-classification", ctx(BOTH))).toMatchObject({
      kind: "model",
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
  });
});

describe("resolveAssignment — the three availability scenarios (acceptance 1)", () => {
  it("resolves the reviewer seat per scenario from the council table", () => {
    const both = resolveAssignment("decomposition-proposal", ctx(BOTH));
    expect(both).toMatchObject({
      kind: "model",
      harness: "claude-code",
      model: "opus-4.8",
      effort: "high",
    });

    const claude = resolveAssignment("decomposition-proposal", ctx(CLAUDE_ONLY));
    expect(claude).toMatchObject({
      kind: "model",
      harness: "claude-code",
      model: "opus-4.8",
      effort: "high",
    });

    const codex = resolveAssignment("decomposition-proposal", ctx(CODEX_ONLY));
    expect(codex).toMatchObject({
      kind: "model",
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    });
  });

  it("resolves a light bulk job per scenario (Luna / Haiku / Luna)", () => {
    expect(resolveAssignment("chunk-titles", ctx(BOTH))).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
    expect(resolveAssignment("chunk-titles", ctx(CLAUDE_ONLY))).toMatchObject({
      harness: "claude-code",
      model: "haiku",
      effort: "low",
    });
    expect(resolveAssignment("chunk-titles", ctx(CODEX_ONLY))).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
  });

  it("resolves the disposition-relevance-judge (#78) via resolveAssignment in every scenario", () => {
    // A model-facing light-tier job routed through the existing council path, so
    // the live budget gate (p0wwp fix, #81) already covers it — no new gate.
    expect(JOB_CATALOGUE["disposition-relevance-judge"]?.tier).toBe("light");
    expect(resolveAssignment("disposition-relevance-judge", ctx(BOTH))).toMatchObject({
      kind: "model",
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "medium",
    });
    expect(resolveAssignment("disposition-relevance-judge", ctx(CLAUDE_ONLY))).toMatchObject({
      harness: "claude-code",
      model: "haiku",
      effort: "low",
    });
    expect(resolveAssignment("disposition-relevance-judge", ctx(CODEX_ONLY))).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "medium",
    });
  });

  it("every table pick's harness matches the model's provider", () => {
    for (const scenario of ["both", "claude-only", "codex-only"] as const) {
      for (const [jobId, tablePick] of Object.entries(ASSIGNMENT_TABLES[scenario])) {
        const resolved = resolveAssignment(jobId, ctx({ installed: scenarioInstalled(scenario) }));
        if (resolved.kind !== "model") throw new Error(`${jobId} unexpectedly deterministic`);
        expect(resolved.model).toBe(tablePick.model);
        expect(resolved.effort).toBe(tablePick.effort);
        expect(resolved.harness).toBe(providerHarness(tablePick.model));
      }
    }
  });
});

function scenarioInstalled(
  scenario: "both" | "claude-only" | "codex-only",
): CouncilAvailability["installed"] {
  if (scenario === "both") return ["claude-code", "codex"];
  if (scenario === "claude-only") return ["claude-code"];
  return ["codex"];
}

describe("resolveAssignment — override precedence (acceptance 1)", () => {
  it("a task override wins over a tier override wins over the table", () => {
    const overrides = {
      task: { "chunk-titles": { model: "opus-4.8" as const } },
      tier: { light: { model: "gpt-5.5" as const, effort: "high" as const } },
    };
    const resolved = resolveAssignment("chunk-titles", ctx(BOTH, { overrides }));
    if (resolved.kind !== "model") throw new Error("expected a model resolution");
    // Task override set the model (Opus, so harness follows to claude-code); the
    // tier override supplied the effort the task override did not set (high); the
    // winning source is task.
    expect(resolved.model).toBe("opus-4.8");
    expect(resolved.harness).toBe("claude-code");
    expect(resolved.effort).toBe("high");
    expect(resolved.trace.source).toBe("task-override");
  });

  it("a tier override alone wins over the table and is traced", () => {
    const resolved = resolveAssignment(
      "claim-extraction",
      ctx(BOTH, {
        overrides: {
          tier: { light: { model: "gpt-5.6-terra" as const, effort: "medium" as const } },
        },
      }),
    );
    if (resolved.kind !== "model") throw new Error("expected a model resolution");
    expect(resolved.model).toBe("gpt-5.6-terra");
    expect(resolved.effort).toBe("medium");
    expect(resolved.trace.source).toBe("tier-override");
  });

  it("a partial (effort-only) task override keeps the table model", () => {
    // No override: Luna low. Effort-only task override -> Luna high (model kept).
    const base = resolveAssignment("chunk-titles", ctx(BOTH));
    expect(base).toMatchObject({ model: "gpt-5.6-luna", effort: "low" });

    const resolved = resolveAssignment(
      "chunk-titles",
      ctx(BOTH, {
        overrides: { task: { "chunk-titles": { effort: "high" as const } } },
      }),
    );
    if (resolved.kind !== "model") throw new Error("expected a model resolution");
    expect(resolved.model).toBe("gpt-5.6-luna"); // table model kept
    expect(resolved.effort).toBe("high"); // overridden
    expect(resolved.harness).toBe("codex"); // follows the (unchanged) model
    expect(resolved.trace.source).toBe("task-override");
  });

  it("no override records 'council-table' as the source", () => {
    const resolved = resolveAssignment("decomposition-proposal", ctx(BOTH));
    expect(resolved.trace.source).toBe("council-table");
    expect(resolved.trace.summary).toContain("no override");
    expect(resolved.trace.summary).toContain("tier=heavy");
    expect(resolved.trace.summary).toContain("both providers");
  });

  it("an overridden model always runs on its own provider's harness — no incoherent pin (#89)", () => {
    // decomposition-proposal resolves to a claude model on claude-code by default.
    // A task override pinning a codex model flips the harness to codex, and the
    // trace summary names that same harness. No input can produce a resolution whose
    // model and harness name different providers — the override carries model/effort
    // only; harness derives from the resolved model on every path.
    const resolved = resolveAssignment(
      "decomposition-proposal",
      ctx(BOTH, {
        overrides: { task: { "decomposition-proposal": { model: "gpt-5.6-luna" as const } } },
      }),
    );
    if (resolved.kind !== "model") throw new Error("expected a model resolution");
    expect(resolved.model).toBe("gpt-5.6-luna");
    expect(resolved.harness).toBe("codex"); // derived from the pinned codex model
    expect(resolved.trace.summary).toContain("(codex)"); // trace records the coherent pair
  });
});

describe("resolveAssignment — R39 cross-harness (acceptance 4)", () => {
  it("a light job resolves to a different harness than the reviewer when both installed", () => {
    const light = resolveAssignment("chunk-titles", ctx(BOTH));
    const reviewer = resolveAssignment("decomposition-proposal", ctx(BOTH));
    if (light.kind !== "model" || reviewer.kind !== "model")
      throw new Error("expected model resolutions");
    expect(light.harness).toBe("codex");
    expect(reviewer.harness).toBe("claude-code");
    expect(light.harness).not.toBe(reviewer.harness);
    expect(light.trace.crossHarness).toBe(true);
    // The reviewer is not cross-harness (it runs on the review harness).
    expect(reviewer.trace.crossHarness).toBeUndefined();
  });

  it("no cross-harness flag under a single-provider scenario", () => {
    const light = resolveAssignment("chunk-titles", ctx(CLAUDE_ONLY));
    if (light.kind !== "model") throw new Error("expected a model resolution");
    expect(light.harness).toBe("claude-code");
    expect(light.trace.crossHarness).toBeUndefined();
  });
});

describe("resolveAssignment — the context-map swarm jobs (#460)", () => {
  it("resolves partition-worker per scenario (Luna / Haiku / Luna) and degraded", () => {
    expect(resolveAssignment("partition-worker", ctx(BOTH))).toMatchObject({
      kind: "model",
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
    expect(resolveAssignment("partition-worker", ctx(CLAUDE_ONLY))).toMatchObject({
      harness: "claude-code",
      model: "haiku",
      effort: "low",
    });
    expect(resolveAssignment("partition-worker", ctx(CODEX_ONLY))).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
    const degraded = resolveAssignment("partition-worker", ctx({ installed: [] }));
    if (degraded.kind !== "model") throw new Error("expected a model resolution");
    expect(degraded.trace.source).toBe("degraded");
  });

  it("resolves map-verify per scenario (Sonnet / Sonnet / Terra) and degraded", () => {
    expect(resolveAssignment("map-verify", ctx(BOTH))).toMatchObject({
      kind: "model",
      harness: "claude-code",
      model: "sonnet-5",
      effort: "medium",
    });
    expect(resolveAssignment("map-verify", ctx(CLAUDE_ONLY))).toMatchObject({
      harness: "claude-code",
      model: "sonnet-5",
      effort: "medium",
    });
    expect(resolveAssignment("map-verify", ctx(CODEX_ONLY))).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-terra",
      effort: "medium",
    });
    const degraded = resolveAssignment("map-verify", ctx({ installed: [] }));
    if (degraded.kind !== "model") throw new Error("expected a model resolution");
    expect(degraded.trace.source).toBe("degraded");
  });

  it("resolves map-scope as the medium whole-slice selector (Sonnet / Sonnet / Terra)", () => {
    expect(JOB_CATALOGUE["map-scope"]).toMatchObject({
      tier: "heavy",
      batching: "per-call",
      sessionRider: false,
    });
    expect(resolveAssignment("map-scope", ctx(BOTH))).toMatchObject({
      kind: "model",
      harness: "claude-code",
      model: "sonnet-5",
      effort: "medium",
    });
    expect(resolveAssignment("map-scope", ctx(CLAUDE_ONLY))).toMatchObject({
      harness: "claude-code",
      model: "sonnet-5",
      effort: "medium",
    });
    expect(resolveAssignment("map-scope", ctx(CODEX_ONLY))).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-terra",
      effort: "medium",
    });
  });

  it("partition-worker is cross-harness under both (light on Codex, review on Claude)", () => {
    const worker = resolveAssignment("partition-worker", ctx(BOTH));
    if (worker.kind !== "model") throw new Error("expected a model resolution");
    expect(worker.trace.crossHarness).toBe(true);
    // The verify seat runs ON the review harness — never cross-harness.
    const verify = resolveAssignment("map-verify", ctx(BOTH));
    if (verify.kind !== "model") throw new Error("expected a model resolution");
    expect(verify.trace.crossHarness).toBeUndefined();
  });
});

describe("resolveAssignment — the board-rebuild drafting seats (#489 B08)", () => {
  const BOARD_SEATS = [
    "lens-draft",
    "lens-draft-flagged",
    "lens-draft-noise",
    "board-post-process",
    "round-report",
  ] as const;

  it("resolves all five board seats under every scenario + degraded", () => {
    for (const jobId of BOARD_SEATS) {
      for (const availability of [BOTH, CLAUDE_ONLY, CODEX_ONLY, { installed: [] }] as const) {
        const resolved = resolveAssignment(jobId, ctx(availability));
        if (resolved.kind !== "model") throw new Error(`${jobId} should resolve to a model`);
        // Harness always follows the resolved model — never an incoherent pin.
        expect(resolved.harness).toBe(providerHarness(resolved.model));
      }
      // Degraded (no council harness) falls to the harness default, honestly traced.
      const degraded = resolveAssignment(jobId, ctx({ installed: [] }));
      if (degraded.kind !== "model") throw new Error(`${jobId} degraded should be a model`);
      expect(degraded.trace.source).toBe("degraded");
    }
  });

  it("routes the heavy drafting seats to Claude under both (the reading surface stays on Claude, R39)", () => {
    expect(resolveAssignment("lens-draft", ctx(BOTH))).toMatchObject({
      harness: "claude-code",
      model: "opus-4.8",
    });
    expect(resolveAssignment("lens-draft-flagged", ctx(BOTH))).toMatchObject({
      harness: "claude-code",
      model: "sonnet-5",
    });
    expect(resolveAssignment("round-report", ctx(BOTH))).toMatchObject({
      harness: "claude-code",
      model: "sonnet-5",
    });
  });

  it("the two light board seats cross to Codex under both; the heavy seats do not", () => {
    for (const jobId of ["lens-draft-noise", "board-post-process"] as const) {
      const light = resolveAssignment(jobId, ctx(BOTH));
      if (light.kind !== "model") throw new Error("expected a model resolution");
      expect(light.harness).toBe("codex");
      expect(light.trace.crossHarness).toBe(true);
    }
    for (const jobId of ["lens-draft", "lens-draft-flagged", "round-report"] as const) {
      const heavy = resolveAssignment(jobId, ctx(BOTH));
      if (heavy.kind !== "model") throw new Error("expected a model resolution");
      expect(heavy.trace.crossHarness).toBeUndefined();
    }
  });

  it("resolves the Codex-only board seats to Codex models", () => {
    for (const jobId of BOARD_SEATS) {
      const resolved = resolveAssignment(jobId, ctx(CODEX_ONLY));
      if (resolved.kind !== "model") throw new Error("expected a model resolution");
      expect(resolved.harness).toBe("codex");
    }
  });
});

describe("resolveAssignment — the related-context jobs (#461)", () => {
  it("resolves related-context-retrieval per scenario (Luna / Haiku / Luna) and degraded", () => {
    expect(resolveAssignment("related-context-retrieval", ctx(BOTH))).toMatchObject({
      kind: "model",
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
    expect(resolveAssignment("related-context-retrieval", ctx(CLAUDE_ONLY))).toMatchObject({
      harness: "claude-code",
      model: "haiku",
      effort: "low",
    });
    expect(resolveAssignment("related-context-retrieval", ctx(CODEX_ONLY))).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
    const degraded = resolveAssignment("related-context-retrieval", ctx({ installed: [] }));
    if (degraded.kind !== "model") throw new Error("expected a model resolution");
    expect(degraded.trace.source).toBe("degraded");
  });

  it("resolves project-scout per scenario (Sonnet / Sonnet / Terra) and degraded", () => {
    expect(resolveAssignment("project-scout", ctx(BOTH))).toMatchObject({
      kind: "model",
      harness: "claude-code",
      model: "sonnet-5",
      effort: "medium",
    });
    expect(resolveAssignment("project-scout", ctx(CLAUDE_ONLY))).toMatchObject({
      harness: "claude-code",
      model: "sonnet-5",
      effort: "medium",
    });
    expect(resolveAssignment("project-scout", ctx(CODEX_ONLY))).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-terra",
      effort: "medium",
    });
    const degraded = resolveAssignment("project-scout", ctx({ installed: [] }));
    if (degraded.kind !== "model") throw new Error("expected a model resolution");
    expect(degraded.trace.source).toBe("degraded");
  });

  it("related-context-retrieval is cross-harness under both (light on Codex, review on Claude)", () => {
    const retrieval = resolveAssignment("related-context-retrieval", ctx(BOTH));
    if (retrieval.kind !== "model") throw new Error("expected a model resolution");
    expect(retrieval.trace.crossHarness).toBe(true);
    // The scout runs ON the review harness — never cross-harness.
    const scout = resolveAssignment("project-scout", ctx(BOTH));
    if (scout.kind !== "model") throw new Error("expected a model resolution");
    expect(scout.trace.crossHarness).toBeUndefined();
  });
});

describe("resolveAssignment — deterministic tier + degraded", () => {
  it("a deterministic-tier job resolves to no model", () => {
    const resolved = resolveAssignment("rsp-validation", ctx(BOTH));
    expect(resolved.kind).toBe("deterministic");
    expect(resolved).not.toHaveProperty("model");
    expect(resolved.trace.tier).toBe("deterministic");
  });

  it("no council harness installed falls to the harness default (degraded)", () => {
    const resolved = resolveAssignment("chunk-titles", ctx({ installed: [] }));
    if (resolved.kind !== "model") throw new Error("expected a model resolution");
    expect(resolved.trace.source).toBe("degraded");
    expect(resolved.trace.scenario).toBe("degraded");
    // The default harness default is Sonnet 5 medium on claude-code.
    expect(resolved).toMatchObject({ harness: "claude-code", model: "sonnet-5", effort: "medium" });
  });

  it("an explicit harnessDefault is honoured in the degraded path", () => {
    const resolved = resolveAssignment(
      "chunk-titles",
      ctx(
        { installed: [] },
        {
          harnessDefault: { harness: "codex", model: "gpt-5.6-luna", effort: "low" },
        },
      ),
    );
    expect(resolved).toMatchObject({
      kind: "model",
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
  });

  it("derives the harness after a contradictory degraded default resolves its model", () => {
    const resolved = resolveAssignment(
      "chunk-titles",
      ctx(
        { installed: [] },
        {
          harnessDefault: { harness: "claude-code", model: "gpt-5.6-luna", effort: "low" },
        },
      ),
    );
    expect(resolved).toMatchObject({
      kind: "model",
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "low",
    });
    expect(resolved.trace.summary).toContain("(codex)");
  });

  it("throws on an unknown jobId (a programming error)", () => {
    expect(() => resolveAssignment("no-such-job", ctx(BOTH))).toThrow(/unknown jobId/);
  });
});
