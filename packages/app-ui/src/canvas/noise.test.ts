import type { NoiseGroup, NoiseReview } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildNoiseIndex, isNoiseGroup } from "./noise";

function group(over: Partial<NoiseGroup> & Pick<NoiseGroup, "groupId">): NoiseGroup {
  return {
    category: "formatting",
    summary: `Group ${over.groupId}`,
    judgedBy: { kind: "rule", rule: "formatting-only" },
    items: [{ anchor: `rennet:hunk/${over.groupId}-1`, detail: "a churn line" }],
    ...over,
  };
}

function ok(groups: NoiseGroup[]): NoiseReview {
  return { status: "ok", groups };
}

describe("buildNoiseIndex — the noise index derivation", () => {
  it("orders groups by category then groupId — a pure function of the group SET", () => {
    const forward = buildNoiseIndex(
      ok([
        group({ groupId: "z", category: "generated" }),
        group({ groupId: "a", category: "formatting" }),
        group({ groupId: "b", category: "lockfile" }),
        group({ groupId: "a2", category: "formatting" }),
      ]),
    );
    const reversed = buildNoiseIndex(
      ok([
        group({ groupId: "a2", category: "formatting" }),
        group({ groupId: "b", category: "lockfile" }),
        group({ groupId: "a", category: "formatting" }),
        group({ groupId: "z", category: "generated" }),
      ]),
    );
    expect(forward).toEqual(reversed);
    if (forward.state !== "ok") throw new Error("expected ok");
    expect(forward.groups.map((g) => g.groupId)).toEqual(["a", "a2", "b", "z"]);
    expect(forward.groups.map((g) => g.category)).toEqual([
      "formatting",
      "formatting",
      "lockfile",
      "generated",
    ]);
  });

  it("carries the judged-by chip through: a rule group and a noise-job group are distinguishable", () => {
    const index = buildNoiseIndex(
      ok([
        group({ groupId: "mech", judgedBy: { kind: "rule", rule: "lockfile" } }),
        group({ groupId: "llm", judgedBy: { kind: "noise-job", model: "Claude" } }),
      ]),
    );
    if (index.state !== "ok") throw new Error("expected ok");
    const byId = new Map(index.groups.map((g) => [g.groupId, g.judgedBy]));
    expect(byId.get("mech")).toEqual({ kind: "rule", rule: "lockfile" });
    expect(byId.get("llm")).toEqual({ kind: "noise-job", model: "Claude" });
    expect(index.counts).toEqual({ rule: 1, noiseJob: 1 });
  });

  // The totality floor: nothing is silently hidden. A deviating line ejects into
  // normal review rather than being suppressed inside its group.
  it("ejects a deviating line into normal review — never suppressed inside the group", () => {
    const index = buildNoiseIndex(
      ok([
        group({
          groupId: "imports",
          category: "import-order",
          judgedBy: { kind: "noise-job", model: "Claude" },
          items: [
            { anchor: "rennet:hunk/i-1", detail: "sorted alphabetically" },
            {
              anchor: "rennet:hunk/i-2",
              detail: "added a new import — a real change",
              deviates: true,
            },
            { anchor: "rennet:hunk/i-3", detail: "grouped std before local" },
          ],
        }),
      ]),
    );
    if (index.state !== "ok") throw new Error("expected ok");
    // The group suppresses only the two non-deviating lines.
    expect(index.groups[0]?.suppressedCount).toBe(2);
    expect(index.groups[0]?.items.map((i) => i.anchor)).toEqual([
      "rennet:hunk/i-1",
      "rennet:hunk/i-3",
    ]);
    // The deviating line is ejected, carrying its origin group + anchor.
    expect(index.ejected).toHaveLength(1);
    expect(index.ejected[0]).toMatchObject({
      groupId: "imports",
      anchor: "rennet:hunk/i-2",
      category: "import-order",
    });
  });

  it("the totality floor holds: suppressedTotal + ejected == every item handed in", () => {
    const groups = [
      group({
        groupId: "a",
        items: [
          { anchor: "x1", detail: "d" },
          { anchor: "x2", detail: "d" },
        ],
      }),
      group({
        groupId: "b",
        items: [
          { anchor: "y1", detail: "d" },
          { anchor: "y2", detail: "d", deviates: true },
          { anchor: "y3", detail: "d" },
        ],
      }),
    ];
    const totalIn = groups.reduce((sum, g) => sum + g.items.length, 0);
    const index = buildNoiseIndex(ok(groups));
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.suppressedTotal + index.ejected.length).toBe(totalIn);
    expect(index.suppressedTotal).toBe(4);
    expect(index.ejected).toHaveLength(1);
  });

  it("suppressed items within a group are ordered by anchor (order-free)", () => {
    const index = buildNoiseIndex(
      ok([
        group({
          groupId: "g",
          items: [
            { anchor: "rennet:hunk/c", detail: "c" },
            { anchor: "rennet:hunk/a", detail: "a" },
            { anchor: "rennet:hunk/b", detail: "b" },
          ],
        }),
      ]),
    );
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.groups[0]?.items.map((i) => i.anchor)).toEqual([
      "rennet:hunk/a",
      "rennet:hunk/b",
      "rennet:hunk/c",
    ]);
  });

  // The load-bearing distinction: a review that RAN and grouped nothing is a
  // different state from a runner that FAILED. The lens must render them apart.
  it("a review with no groups is honestly EMPTY (ok, zero groups), not failed", () => {
    const index = buildNoiseIndex(ok([]));
    expect(index.state).toBe("ok");
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.groups).toEqual([]);
    expect(index.suppressedTotal).toBe(0);
    expect(index.groupCount).toBe(0);
    expect(index.ejected).toEqual([]);
  });

  it("a failed runner is a DISTINCT state carrying its reason, never 'no noise'", () => {
    const index = buildNoiseIndex({ status: "failed", reason: "the noise runner timed out" });
    expect(index.state).toBe("failed");
    if (index.state !== "failed") throw new Error("expected failed");
    expect(index.reason).toBe("the noise runner timed out");
  });

  it("NEVER surfaces a malformed group as noise (strict guard)", () => {
    const junk = {
      groupId: "junk",
      category: "not-a-category",
      summary: "looks like a group",
      judgedBy: { kind: "vibes" },
      items: [],
    } as unknown as NoiseGroup;
    const good = group({ groupId: "real", category: "lockfile" });
    const index = buildNoiseIndex(ok([junk, good]));
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.groups).toHaveLength(1);
    expect(index.groups[0]?.groupId).toBe("real");
  });

  it("drops a group whose items array holds a malformed entry (whole-group, never a silent gap)", () => {
    const bad = {
      groupId: "bad",
      category: "formatting",
      summary: "one bad item",
      judgedBy: { kind: "rule", rule: "formatting-only" },
      items: [{ anchor: "ok", detail: "fine" }, { detail: "no anchor" }],
    } as unknown as NoiseGroup;
    const index = buildNoiseIndex(ok([bad]));
    if (index.state !== "ok") throw new Error("expected ok");
    expect(index.groups).toEqual([]);
  });
});

describe("isNoiseGroup — the strict noise-group guard", () => {
  it("accepts a well-formed group", () => {
    expect(isNoiseGroup(group({ groupId: "x" }))).toBe(true);
  });

  it("accepts a noise-job group", () => {
    expect(
      isNoiseGroup(group({ groupId: "x", judgedBy: { kind: "noise-job", model: "Codex" } })),
    ).toBe(true);
  });

  it("rejects null, non-objects, a wrong category, and a junk judged-by", () => {
    expect(isNoiseGroup(null)).toBe(false);
    expect(isNoiseGroup("noise")).toBe(false);
    expect(isNoiseGroup({ ...group({ groupId: "x" }), category: "nope" })).toBe(false);
    expect(isNoiseGroup({ ...group({ groupId: "x" }), judgedBy: { kind: "rule" } })).toBe(false);
    expect(isNoiseGroup({ ...group({ groupId: "x" }), judgedBy: { kind: "noise-job" } })).toBe(
      false,
    );
  });
});
