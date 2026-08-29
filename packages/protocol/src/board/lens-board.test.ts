import { describe, expect, it } from "vitest";
import { LENS_KINDS } from "../manifests";
import {
  DOMAIN_COUNT_KINDS,
  fallbackBoardDocument,
  LensBoardSchema,
  LensKindSchema,
  RoundReportBoardSchema,
  resolveBoardDocument,
} from "./lens-board";
import { HOST_KIND_SCHEMAS, HostElementSchema } from "./schema";

const author = { kind: "lens-agent", id: "lens:design" } as const;

// A full fixture projection: sections with fold lines, a small element tree,
// and skipped-hunk coverage data.
const fixture = {
  lens: "design",
  generation: "gen-1",
  boardId: "board-1",
  document: {
    title: "Design · durable refresh observations",
    introMarkdown: "The specification and implementation agree on one write path.",
    measure: "structured",
    sources: [
      { path: "openspec/changes/refresh/proposal.md", label: "proposal.md" },
      { path: "openspec/changes/refresh/design.md", label: "design.md", line: 14 },
    ],
    stats: [{ label: "Tasks", value: "11/13" }],
  },
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

  it("requires a served document and keeps legacy raw count keys readable", () => {
    expect(LensBoardSchema.safeParse({ ...fixture, document: undefined }).success).toBe(false);
    expect(LensBoardSchema.safeParse(fixture).success).toBe(true);
    expect(DOMAIN_COUNT_KINDS).not.toContain("finding");
  });

  it("completes legacy metadata deterministically without invented intro prose", () => {
    expect(fallbackBoardDocument("design")).toEqual({
      title: "Design",
      introMarkdown: "",
      measure: "structured",
    });
    expect(fallbackBoardDocument("noise")).toEqual({
      title: "Noise",
      introMarkdown: "",
      measure: "reading",
    });
    expect(
      resolveBoardDocument("sequence", {
        title: "Follow the durable write",
        introMarkdown: "The reader starts at persistence.",
        measure: "structured",
        sources: [{ path: "openspec/changes/write/design.md", label: "design.md" }],
        stats: [{ label: "Steps", value: "4" }],
      }),
    ).toEqual({
      title: "Follow the durable write",
      introMarkdown: "The reader starts at persistence.",
      measure: "reading",
      sources: [{ path: "openspec/changes/write/design.md", label: "design.md" }],
      stats: [{ label: "Steps", value: "4" }],
    });
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

  it("gives report projections their own identity and excludes human review comments", () => {
    const report = {
      ...fixture,
      lens: "report",
      document: { ...fixture.document, measure: "reading" },
    };
    expect(RoundReportBoardSchema.safeParse(report).success).toBe(true);
    expect(LensBoardSchema.safeParse(report).success).toBe(false);

    const withReviewComment = {
      ...report,
      elements: [
        ...report.elements,
        {
          id: "review-1",
          kind: "review_comment",
          data: {
            author: { kind: "human", id: "reviewer" },
            body: "Ship it.",
            code_ref: "cr1",
            status: "draft",
            covers: [],
          },
        },
      ],
    };
    const result = RoundReportBoardSchema.safeParse(withReviewComment);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["elements", report.elements.length, "kind"],
          message: "round reports cannot contain review comments",
        }),
      );
    }
  });
});
