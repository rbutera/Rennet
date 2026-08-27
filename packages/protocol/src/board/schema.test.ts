import { dataValidator } from "@wboard/core";
import { describe, expect, it } from "vitest";
import {
  AUTHORED_BOARD_SCHEMA,
  BOARD_WIRE_SCHEMA,
  DRAFT_KIND_SCHEMAS,
  DRAFT_OMITTED_KINDS,
  DraftElementSchema,
  HOST_KIND_SCHEMAS,
  HostBoardSchema,
  HostElementSchema,
  parseDraft,
  WireSchema,
} from "./schema";

// The 13 kinds of the #462 closed palette — the recorded snapshot. Adding or
// dropping a kind on Host without updating this list fails drift test 1.
const EXPECTED_HOST_KINDS = [
  "finding",
  "decision",
  "requirement",
  "noise_verdict",
  "order_step",
  "round_outcome",
  "section",
  "prose",
  "callout",
  "annotation",
  "message",
  "code_ref",
  "review_comment",
].sort();

const author = { kind: "lens-agent", id: "lens:design" } as const;

// A fixture board exercising every one of the 13 kinds.
const fullBoard = {
  elements: [
    {
      id: "cr1",
      kind: "code_ref",
      data: {
        author,
        patchset_id: "ps1",
        path: "src/a.ts",
        side: "head",
        start_line: 10,
        end_line: 20,
        symbol: "foo",
      },
    },
    {
      id: "f1",
      kind: "finding",
      data: {
        author,
        severity: "high",
        concern: "leaks a handle",
        code: ["cr1"],
        concurrence: [{ model: "m", agree: 3, total: 3 }],
        status: "open",
      },
    },
    {
      id: "d1",
      kind: "decision",
      data: {
        author,
        statement: "use a pool",
        evidence: ["cr1"],
        alternatives: ["p1"],
        why: "throughput",
      },
    },
    {
      id: "req1",
      kind: "requirement",
      data: { author, shall: "must close handles", coverage: "met", trace: ["cr1"] },
    },
    {
      id: "nv1",
      kind: "noise_verdict",
      data: { author, hunk: "cr1", verdict: "signal", reason: "real change", judge: "llm" },
    },
    {
      id: "os1",
      kind: "order_step",
      data: { author, title: "read the pool", span: "cr1", children: ["f1"] },
    },
    {
      id: "ro1",
      kind: "round_outcome",
      data: {
        author,
        status: "addressed",
        ask: { ref: "ask1", text: "close the handle" },
        note: "done",
        code_ref: "cr1",
      },
    },
    {
      id: "s1",
      kind: "section",
      data: { author, title: "Findings", children: ["f1"], delta: "new" },
    },
    { id: "p1", kind: "prose", data: { author, markdown: "Some **prose**." } },
    { id: "c1", kind: "callout", data: { author, variant: "warning", body: "heads up" } },
    { id: "an1", kind: "annotation", data: { author, code_ref: "cr1", body: "note here" } },
    {
      id: "m1",
      kind: "message",
      data: {
        author: { kind: "human", id: "rai" },
        role: "question",
        reply_to: "f1",
        code_ref: "cr1",
        quote: { target: "p1", quote: "prose", offsetHint: 5 },
        lifecycle: "staged",
      },
    },
    {
      id: "rc1",
      kind: "review_comment",
      data: {
        author: { kind: "human", id: "rai" },
        body: "please fix",
        code_ref: "cr1",
        status: "draft",
        covers: ["f1"],
      },
    },
  ],
};

// The same board with the curation-side kinds removed — a lens draft.
const draftBoard = {
  elements: fullBoard.elements.filter(
    (e) => !(DRAFT_OMITTED_KINDS as readonly string[]).includes(e.kind),
  ),
};

const kindsOf = (union: typeof HostElementSchema): string[] =>
  union.options.map((o) => o.shape.kind.value as string).sort();

describe("host board schema (#462)", () => {
  it("parses a fixture exercising every one of the 13 kinds", () => {
    const r = HostBoardSchema.safeParse(fullBoard);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2)).toBe(true);
  });

  it("rejects an unknown kind (closed palette)", () => {
    const r = HostBoardSchema.safeParse({
      elements: [{ id: "x", kind: "custom", data: { author } }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an out-of-vocabulary enum value", () => {
    const bad = {
      elements: [
        {
          id: "f1",
          kind: "finding",
          data: { author, severity: "critical", concern: "c", status: "open" },
        },
      ],
    };
    expect(HostBoardSchema.safeParse(bad).success).toBe(false);
  });

  // #462 marks optional attributes with `?`; these carry none, so a missing
  // field must reject (codex review finding 7 — tightening later would be
  // wire-breaking).
  it.each([
    ["finding", "code"],
    ["finding", "concurrence"],
    ["decision", "evidence"],
    ["decision", "alternatives"],
    ["requirement", "trace"],
    ["order_step", "children"],
    ["section", "children"],
    ["review_comment", "covers"],
  ] as const)("rejects a %s missing its required %s", (kind, field) => {
    const el = fullBoard.elements.find((e) => e.kind === kind);
    if (!el) throw new Error(`fixture has no ${kind}`);
    const { [field]: _dropped, ...data } = el.data as Record<string, unknown>;
    expect(HostElementSchema.safeParse({ ...el, data }).success).toBe(false);
  });

  it("passes undeclared data fields through (extras)", () => {
    const withExtra = {
      elements: [{ id: "p1", kind: "prose", data: { author, markdown: "x", note: 1 } }],
    };
    const r = HostBoardSchema.safeParse(withExtra);
    expect(r.success).toBe(true);
  });
});

describe("draft board seam (parseDraft)", () => {
  it("parses a draft fixture", () => {
    const r = parseDraft(draftBoard);
    expect(r.ok, r.ok ? "" : JSON.stringify(r.issues, null, 2)).toBe(true);
  });

  it("rejects a curation-side kind in a draft, returning issues", () => {
    const r = parseDraft({
      elements: [{ id: "m1", kind: "message", data: { author, role: "question" } }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("drift test 1 — DraftBoardSchema stays the derivation", () => {
  it("Host is exactly the recorded 13-kind palette", () => {
    // Bites when a 14th kind is added to Host without updating the snapshot.
    expect(kindsOf(HostElementSchema)).toEqual(EXPECTED_HOST_KINDS);
    expect(Object.keys(HOST_KIND_SCHEMAS).sort()).toEqual(EXPECTED_HOST_KINDS);
  });

  it("Draft kinds === Host kinds minus the recorded omit set (computed from the schemas)", () => {
    const hostKinds = kindsOf(HostElementSchema);
    const draftKinds = kindsOf(DraftElementSchema);
    const expectedDraft = hostKinds
      .filter((k) => !(DRAFT_OMITTED_KINDS as readonly string[]).includes(k))
      .sort();
    // Reads the COMPILED unions, so a hand-written / drifted Draft is caught here.
    expect(draftKinds).toEqual(expectedDraft);
    expect(Object.keys(DRAFT_KIND_SCHEMAS).sort()).toEqual(expectedDraft);
  });
});

describe("drift test 2 — Zod authoring layer stays in step with the wire", () => {
  it("compiles through the kit to a shape the kit's wire schema accepts", () => {
    const r = WireSchema.safeParse(BOARD_WIRE_SCHEMA);
    expect(r.success, r.success ? "" : JSON.stringify(r.error?.issues, null, 2)).toBe(true);
    expect(BOARD_WIRE_SCHEMA.kinds.map((k) => k.id).sort()).toEqual(EXPECTED_HOST_KINDS);
  });

  it("every fixture element's data validates against the kit's per-kind validator", () => {
    // Couples the rich Zod topology to the authored wire types: change any
    // attribute's wire type and the fixture stops validating against the kit.
    for (const el of fullBoard.elements) {
      const validator = dataValidator(AUTHORED_BOARD_SCHEMA, el.kind);
      const r = validator.safeParse(el.data);
      expect(r.success, `${el.kind}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(
        true,
      );
    }
  });
});
