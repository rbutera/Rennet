import { describe, expect, it } from "vitest";
import {
  clientSettingsSchema,
  councilModelSchema,
  reviewRoleCellSchema,
  reviewRoleMappingSchema,
  reviewRoleScenarioSchema,
  settingsViewSchema,
} from "./wire";

// C16 (#485): the model-council review-role mappings on the wire. These are the
// boundary between core's `resolveReviewRoles` and the app-ui Review surface, so
// the round-trips below are the honest-null / honest-provenance contract itself.

describe("review-role mapping wire schemas (C16)", () => {
  it("round-trips an honest-null cell (a role that does not run in a scenario)", () => {
    const nullCell = { value: null, layer: "default" as const };
    expect(reviewRoleCellSchema.parse(nullCell)).toEqual(nullCell);
  });

  it("round-trips a real cell carrying its override provenance", () => {
    const overridden = {
      value: { model: "opus-4.8" as const, effort: "high" as const },
      layer: "override" as const,
    };
    expect(reviewRoleCellSchema.parse(overridden)).toEqual(overridden);
  });

  it("round-trips the Flagged Second Seat: a real dual pick, honest-null single-provider", () => {
    const secondSeat = {
      id: "second-seat",
      label: "Flagged Second Seat",
      hint: "Dual-provider only.",
      dual: {
        value: { model: "gpt-5.6-sol" as const, effort: "high" as const },
        layer: "default" as const,
      },
      claudeOnly: { value: null, layer: "default" as const },
      codexOnly: { value: null, layer: "default" as const },
    };
    expect(reviewRoleMappingSchema.parse(secondSeat)).toEqual(secondSeat);
  });

  it("rejects a model outside the council set (boundary validation, not a passthrough)", () => {
    expect(() => councilModelSchema.parse("gpt-4o")).toThrow();
    expect(() =>
      reviewRoleCellSchema.parse({ value: { model: "made-up", effort: "high" }, layer: "default" }),
    ).toThrow();
  });

  it("only the two collapsed layers are valid provenance", () => {
    expect(() => reviewRoleCellSchema.parse({ value: null, layer: "council-table" })).toThrow();
    expect(reviewRoleScenarioSchema.options).toEqual(["dual", "claudeOnly", "codexOnly"]);
  });

  it("reviewRoles rides settings.get additively (an omitting view still parses)", () => {
    const base = {
      scheme: "system" as const,
      schemeProvenance: { layer: "builtin" as const, contributions: [] },
      appearanceMalformed: false,
      projects: [],
    };
    expect(settingsViewSchema.parse(base).reviewRoles).toBeUndefined();
    const withRoles = settingsViewSchema.parse({
      ...base,
      reviewRoles: [
        {
          id: "orchestrator",
          label: "Orchestrator",
          hint: "The review seat.",
          dual: { value: { model: "opus-4.8", effort: "high" }, layer: "default" },
          claudeOnly: { value: { model: "opus-4.8", effort: "high" }, layer: "default" },
          codexOnly: { value: { model: "gpt-5.6-sol", effort: "high" }, layer: "default" },
        },
      ],
    });
    expect(withRoles.reviewRoles).toHaveLength(1);
  });

  it("clientSettings carries PER-SCENARIO routing.task overrides, model+effort only (#89)", () => {
    const parsed = clientSettingsSchema.parse({
      version: 1,
      routing: { task: { "lens-draft": { codexOnly: { model: "gpt-5.5", effort: "low" } } } },
    });
    // Only the edited column carries a cell; the siblings stay absent (Rai, 2026-08-28).
    expect(parsed.routing?.task?.["lens-draft"]).toEqual({
      codexOnly: { model: "gpt-5.5", effort: "low" },
    });
    // A harness field is not part of the override shape — it is stripped, never persisted.
    const stripped = clientSettingsSchema.parse({
      version: 1,
      routing: {
        task: { "lens-draft": { dual: { model: "opus-4.8", effort: "high", harness: "codex" } } },
      },
    });
    expect(stripped.routing?.task?.["lens-draft"]?.dual).toEqual({
      model: "opus-4.8",
      effort: "high",
    });
    // The OLD job-keyed shape is no longer a routing override: a bare pick has no
    // scenario key, so it parses to an empty cell set rather than a job-wide override.
    expect(
      clientSettingsSchema.parse({
        version: 1,
        routing: { task: { "lens-draft": { model: "haiku", effort: "low" } } },
      }).routing?.task?.["lens-draft"],
    ).toEqual({});
  });
});
