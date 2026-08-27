import { describe, expect, it } from "vitest";
import { LENS_KINDS } from "../manifests";
import { LensBoardSchema, LensKindSchema } from "./lens-board";
import { HOST_KIND_SCHEMAS, HostElementSchema } from "./schema";

const author = { kind: "lens-agent", id: "lens:design" } as const;

// A full fixture projection: sections with fold lines, a small element tree,
// and skipped-hunk coverage data.
const fixture = {
  lens: "design",
  generation: "gen-1",
  boardId: "board-1",
  sections: [
    {
      ref: "s1",
      gist: "2 findings, 1 cited span",
      counts: { finding: 1, code_ref: 1 },
      delta: "new",
    },
    { ref: "s2", gist: "carried prose", counts: {} },
  ],
  elements: [
    {
      id: "s1",
      kind: "section",
      data: { author, title: "Findings", children: ["f1", "cr1"], delta: "new" },
    },
    { id: "s2", kind: "section", data: { author, title: "Notes", children: ["p1"] } },
    {
      id: "cr1",
      kind: "code_ref",
      data: {
        author,
        patchset_id: "ps1",
        path: "src/a.ts",
        side: "head",
        start_line: 1,
        end_line: 4,
      },
    },
    {
      id: "f1",
      kind: "finding",
      data: {
        author,
        severity: "low",
        concern: "nit",
        code: ["cr1"],
        concurrence: [],
        status: "open",
      },
    },
    { id: "p1", kind: "prose", data: { author, markdown: "context." } },
  ],
  skippedHunks: [{ hunk: "hunk-9", reason: "mechanical lockfile churn — Noise's lane" }],
};

describe("LensBoard projection (client asset risk 1)", () => {
  it("parses a full fixture projection", () => {
    const r = LensBoardSchema.safeParse(fixture);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2)).toBe(true);
  });

  it("rejects a lens id outside the manifests vocabulary", () => {
    expect(LensBoardSchema.safeParse({ ...fixture, lens: "spec" }).success).toBe(false);
    expect(LensKindSchema.options).toEqual([...LENS_KINDS]);
  });

  it("element vocabulary IS the host union — reference identity, drifts with drift test 1", () => {
    // The projection embeds HostElementSchema itself, not a copy: a 14th host
    // kind (or a dropped one) changes this union and drift test 1 together.
    expect(LensBoardSchema.shape.elements.element).toBe(HostElementSchema);
    const lensKinds = LensBoardSchema.shape.elements.element.options
      .map((o) => o.shape.kind.value as string)
      .sort();
    expect(lensKinds).toEqual(Object.keys(HOST_KIND_SCHEMAS).sort());
  });

  it("rejects an element outside the 13-kind vocabulary", () => {
    const bad = {
      ...fixture,
      elements: [{ id: "x", kind: "custom", data: { author } }],
    };
    expect(LensBoardSchema.safeParse(bad).success).toBe(false);
  });
});
