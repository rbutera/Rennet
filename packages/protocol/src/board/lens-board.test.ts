import { describe, expect, it } from "vitest";
import { LENS_KINDS } from "../manifests";
import {
  DOMAIN_COUNT_KINDS,
  fallbackBoardDocument,
  LensBoardSchema,
  LensKindSchema,
  projectBoardSections,
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

  // The #927 shape, from the persisted board log: the Codex seat minted a SECOND top-level
  // section ("Proposal fidelity") and hung three bare code_refs off it before its findings,
  // which rendered as a heading over orphaned code blocks. `codeRef`/`finding`/`section`
  // build the exact element tree that board carried.
  const codeRef = (id: string, path: string) => ({
    id,
    kind: "code_ref",
    data: { author, patchset_id: "ps1", path, side: "head", start_line: 1, end_line: 4 },
  });
  const finding = (id: string, concern: string, code: string[]) => ({
    id,
    kind: "finding",
    data: { author, severity: "medium", concern, code, concurrence: [], status: "open" },
  });
  const section = (id: string, title: string, children: string[]) => ({
    id,
    kind: "section",
    data: { author, title, children },
  });

  describe("Flagged orphan-section guard (#927)", () => {
    // fe1 "Findings" owns fe4; ge5 "Proposal fidelity" hangs three bare code_refs then its
    // own finding ge9 (and re-lists fe4). A third section is pure orphan citation.
    const elements = [
      section("fe1", "Findings", ["fe4"]),
      section("ge5", "Proposal fidelity", ["ge6", "ge7", "ge8", "ge9", "fe4"]),
      section("or1", "Orphans", ["cr9"]),
      codeRef("ge6", "src/design-assembler.ts"),
      codeRef("ge7", "src/design-structure.tsx"),
      codeRef("ge8", "src/design-assembler.ts"),
      codeRef("cr9", "src/other.ts"),
      finding("ge9", "Impact jumps ahead of intervening proposal headings", ["ge7"]),
      finding("fe4", "What Changes text outside its bullet list is dropped", ["cr9"]),
    ];

    it("drops a finding-less Flagged section and never counts an orphan code_ref as a file", () => {
      const refs = projectBoardSections(elements, "flagged");
      // The pure-orphan "Orphans" section is gone; the two sections with findings survive.
      expect(refs.map((s) => s.ref)).toEqual(["fe1", "ge5"]);
      const proposal = refs.find((s) => s.ref === "ge5");
      // ge5 keeps its two findings; its three orphan code_refs are not counted as files.
      expect(proposal?.counts).toEqual({ findings: 2 });
    });

    it("POSITIVE CONTROL: on a non-Flagged lens the guard does not fire", () => {
      // Same elements, design lens: the orphan section survives and code_refs count as files.
      // This is the discriminating pair — remove the guard and the flagged case above turns
      // into this; broaden the guard past flagged and this case turns into the one above.
      const refs = projectBoardSections(elements, "design");
      expect(refs.map((s) => s.ref)).toEqual(["fe1", "ge5", "or1"]);
      const proposal = refs.find((s) => s.ref === "ge5");
      expect(proposal?.counts).toEqual({ findings: 2, files: 2 });
    });
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
