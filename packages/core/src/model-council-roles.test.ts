import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_SECOND_SEAT_EFFORT, DEFAULT_CODEX_SECOND_SEAT_MODEL } from "./dual-seat";
import { JOB_CATALOGUE } from "./model-council";
import {
  REVIEW_ROLE_CATALOGUE,
  type ResolvedReviewRole,
  type ReviewRoleResolveContext,
  resolveReviewRoles,
  reviewRoleCatalogueIsIntegral,
} from "./model-council-roles";

// No overrides: the pure council tables, all three scenarios (honest-present).
const CTX: ReviewRoleResolveContext = {};

function role(roles: ResolvedReviewRole[], id: string): ResolvedReviewRole {
  const found = roles.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no role ${id}`);
  return found;
}

describe("REVIEW_ROLE_CATALOGUE", () => {
  it("names all six review roles", () => {
    expect(REVIEW_ROLE_CATALOGUE).toHaveLength(6);
    expect(REVIEW_ROLE_CATALOGUE.map((r) => r.id).sort()).toEqual(
      [
        "adjudication",
        "confirmation",
        "lens-workers",
        "orchestrator",
        "post-process",
        "second-seat",
      ].sort(),
    );
  });

  // Positive control (must be able to fail): a role naming a job id absent from
  // JOB_CATALOGUE is a fabrication — the no-new-job-id guard.
  it("points only at job ids that exist in JOB_CATALOGUE", () => {
    for (const entry of REVIEW_ROLE_CATALOGUE) {
      expect(JOB_CATALOGUE[entry.jobId], `${entry.id} → ${entry.jobId}`).toBeDefined();
    }
    expect(reviewRoleCatalogueIsIntegral()).toBe(true);
  });
});

describe("resolveReviewRoles", () => {
  it("resolves every role in every scenario to an assignment or honest-null (never undefined, never a throw)", () => {
    const roles = resolveReviewRoles(CTX);
    expect(roles).toHaveLength(6);
    for (const r of roles) {
      for (const cell of [r.dual, r.claudeOnly, r.codexOnly]) {
        // a cell is EITHER a real pick with a source, OR honest-null with null source.
        if (cell.value === null) {
          expect(cell.source).toBeNull();
        } else {
          expect(cell.value.model).toBeTruthy();
          expect(cell.value.effort).toBeTruthy();
          expect(cell.source).not.toBeNull();
        }
      }
    }
  });

  it("resolves the table-backed roles to the council default with council-table provenance", () => {
    const roles = resolveReviewRoles(CTX);
    // lens-workers → lens-draft: TABLE_BOTH opus-4.8/high, claude-only opus-4.8/high, codex-only gpt-5.6-sol/high.
    const lens = role(roles, "lens-workers");
    expect(lens.dual.value).toEqual({ model: "opus-4.8", effort: "high" });
    expect(lens.dual.source).toBe("council-table");
    expect(lens.codexOnly.value).toEqual({ model: "gpt-5.6-sol", effort: "high" });
  });

  it("resolves the Flagged second-seat in dual and honest-null in the single-provider columns", () => {
    const second = role(resolveReviewRoles(CTX), "second-seat");
    expect(second.dual.value).toEqual({
      model: DEFAULT_CODEX_SECOND_SEAT_MODEL,
      effort: DEFAULT_CODEX_SECOND_SEAT_EFFORT,
    });
    expect(second.dual.source).toBe("council-table");
    // Honest-null: the dual construct does not run under one provider.
    expect(second.claudeOnly.value).toBeNull();
    expect(second.claudeOnly.source).toBeNull();
    expect(second.codexOnly.value).toBeNull();
    expect(second.codexOnly.source).toBeNull();
  });

  it("a task override changes the resolved cell AND flips its source to task-override", () => {
    const overridden = resolveReviewRoles({
      overrides: { "lens-draft": { dual: { model: "haiku", effort: "low" } } },
    });
    const lens = role(overridden, "lens-workers");
    expect(lens.dual.value).toEqual({ model: "haiku", effort: "low" });
    expect(lens.dual.source).toBe("task-override");
    // the default (no override) stays council-table — proves the flip is real.
    expect(role(resolveReviewRoles(CTX), "lens-workers").dual.source).toBe("council-table");
  });

  it("a task override on the flagged job reflects in the second-seat dual cell", () => {
    const overridden = resolveReviewRoles({
      overrides: { "lens-draft-flagged": { dual: { model: "gpt-5.6-terra", effort: "medium" } } },
    });
    const second = role(overridden, "second-seat");
    expect(second.dual.value).toEqual({ model: "gpt-5.6-terra", effort: "medium" });
    expect(second.dual.source).toBe("task-override");
    // still honest-null single-provider.
    expect(second.codexOnly.value).toBeNull();
  });

  // ── PER-SCENARIO positive control (Rai, 2026-08-28) ────────────────────────
  // MUST FAIL if the job-keyed shape sneaks back: with the old `task[jobId] =
  // pick` layering, one edit moved all three columns, so `dual` and `claudeOnly`
  // below would read haiku/low with `task-override` provenance.
  it("an override in codexOnly moves ONLY that column — dual and claudeOnly keep the council table", () => {
    const baseline = role(resolveReviewRoles(CTX), "lens-workers");
    const overridden = role(
      resolveReviewRoles({
        overrides: { "lens-draft": { codexOnly: { model: "haiku", effort: "low" } } },
      }),
      "lens-workers",
    );

    // The edited column moved, with honest override provenance.
    expect(overridden.codexOnly.value).toEqual({ model: "haiku", effort: "low" });
    expect(overridden.codexOnly.source).toBe("task-override");

    // The siblings are byte-identical to the no-override resolution.
    expect(overridden.dual).toEqual(baseline.dual);
    expect(overridden.claudeOnly).toEqual(baseline.claudeOnly);
    expect(overridden.dual.source).toBe("council-table");
    expect(overridden.claudeOnly.source).toBe("council-table");
    expect(overridden.dual.value).toEqual({ model: "opus-4.8", effort: "high" });
  });

  it("two columns of one job hold independent overrides", () => {
    const roles = resolveReviewRoles({
      overrides: {
        "lens-draft": {
          dual: { model: "sonnet-5", effort: "medium" },
          codexOnly: { model: "gpt-5.5", effort: "low" },
        },
      },
    });
    const lens = role(roles, "lens-workers");
    expect(lens.dual.value).toEqual({ model: "sonnet-5", effort: "medium" });
    expect(lens.codexOnly.value).toEqual({ model: "gpt-5.5", effort: "low" });
    // The untouched column still reads the table.
    expect(lens.claudeOnly.value).toEqual({ model: "opus-4.8", effort: "high" });
    expect(lens.claudeOnly.source).toBe("council-table");
  });
});
