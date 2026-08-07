import type { CouncilAvailability, CouncilResolveContext } from "@rennet/types";
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

  it("throws on an unknown jobId (a programming error)", () => {
    expect(() => resolveAssignment("no-such-job", ctx(BOTH))).toThrow(/unknown jobId/);
  });
});
