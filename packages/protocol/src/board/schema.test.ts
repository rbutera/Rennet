import { dataValidator } from "@wboard/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
        quote_target: "p1",
        quote: { quote: "prose", offsetHint: 5 },
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
    const data = Object.fromEntries(
      Object.entries(el.data as Record<string, unknown>).filter(([key]) => key !== field),
    );
    expect(HostElementSchema.safeParse({ ...el, data }).success).toBe(false);
  });

  it("rejects a quote descriptor without its element target (and vice versa)", () => {
    const message = (data: Record<string, unknown>) =>
      HostElementSchema.safeParse({
        id: "m9",
        kind: "message",
        data: { author, role: "question", ...data },
      }).success;
    expect(message({ quote: { quote: "prose" } })).toBe(false);
    expect(message({ quote_target: "p1" })).toBe(false);
    expect(message({ quote_target: "p1", quote: { quote: "prose" } })).toBe(true);
  });

  it("passes undeclared data fields through (extras)", () => {
    const withExtra = {
      elements: [{ id: "p1", kind: "prose", data: { author, markdown: "x", note: 1 } }],
    };
    const r = HostBoardSchema.safeParse(withExtra);
    expect(r.success).toBe(true);
  });
});

// The omit POLICY, pinned independently of production `DRAFT_OMITTED_KINDS`
// (#462's curation-side tier: human discussion + the GitHub-anchored human
// comment). If the production set drifts — a kind added or removed — the pin
// fails even though the derivation below still holds. (Codex finding 4: the
// policy and the derivation are separate drift surfaces.)
const EXPECTED_DRAFT_OMITTED = ["message", "review_comment"].sort();

describe("draft board seam (parseDraft)", () => {
  it("parses a draft fixture", () => {
    const r = parseDraft(draftBoard);
    expect(r.ok, r.ok ? "" : JSON.stringify(r.issues, null, 2)).toBe(true);
  });

  it.each(EXPECTED_DRAFT_OMITTED)(
    "rejects the curation-side kind %s in a draft, returning issues",
    (kind) => {
      const el = fullBoard.elements.find((e) => e.kind === kind);
      if (!el) throw new Error(`fixture has no ${kind}`);
      const r = parseDraft({ elements: [el] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
    },
  );
});

describe("drift test 1 — DraftBoardSchema stays the derivation", () => {
  it("Host is exactly the recorded 13-kind palette", () => {
    // Bites when a 14th kind is added to Host without updating the snapshot.
    expect(kindsOf(HostElementSchema)).toEqual(EXPECTED_HOST_KINDS);
    expect(Object.keys(HOST_KIND_SCHEMAS).sort()).toEqual(EXPECTED_HOST_KINDS);
  });

  it("the omit set IS the recorded curation-side policy", () => {
    // Pinned literal vs production constant: dropping (or adding) an omitted
    // kind fails here even though the derivation test below would stay green.
    expect([...DRAFT_OMITTED_KINDS].sort()).toEqual(EXPECTED_DRAFT_OMITTED);
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

  // Classify a Zod attribute the way the authored table declares one. Computed
  // from the schema object itself — no third hand-kept list (codex finding 5).
  const zodAttr = (schema: z.ZodType): { required: boolean; many: boolean; base: string } => {
    let s: z.ZodType = schema;
    let required = true;
    if (s instanceof z.ZodOptional) {
      required = false;
      s = s.unwrap() as z.ZodType;
    }
    let many = false;
    if (s instanceof z.ZodArray) {
      many = true;
      s = s.element as z.ZodType;
    }
    const base =
      s instanceof z.ZodNumber
        ? "number"
        : s instanceof z.ZodBoolean
          ? "boolean"
          : s instanceof z.ZodString || s instanceof z.ZodEnum || s instanceof z.ZodLiteral
            ? "stringlike"
            : "json";
    return { required, many, base };
  };
  // A Zod string can lower to wire `string` OR `element` (an element id is a
  // plain string) — the one dimension this comparison cannot pin. Everything
  // else (names, requiredness, arity, number/boolean/json vs scalar) drifts loudly.
  const WIRE_TYPES_FOR_BASE: Record<string, readonly string[]> = {
    stringlike: ["string", "element"],
    number: ["number"],
    boolean: ["boolean"],
    json: ["json"],
  };

  it("authored attribute topology matches the Zod layer per kind (names, requiredness, arity)", () => {
    for (const [kind, kindSchema] of Object.entries(HOST_KIND_SCHEMAS)) {
      const authoredAttrs = AUTHORED_BOARD_SCHEMA[kind as keyof typeof AUTHORED_BOARD_SCHEMA]
        .attributes as Record<string, { type: string; required: boolean; many?: boolean }>;
      const dataSchema = kindSchema.shape.data as z.ZodObject<z.ZodRawShape>;
      const zodShape = dataSchema.shape;

      expect(Object.keys(authoredAttrs).sort(), `${kind}: attribute name sets`).toEqual(
        Object.keys(zodShape).sort(),
      );
      for (const [name, attr] of Object.entries(authoredAttrs)) {
        const z_ = zodAttr(zodShape[name] as z.ZodType);
        expect(attr.required, `${kind}.${name}: requiredness`).toBe(z_.required);
        expect(Boolean(attr.many), `${kind}.${name}: arity (many)`).toBe(z_.many);
        expect(
          WIRE_TYPES_FOR_BASE[z_.base],
          `${kind}.${name}: wire type ${attr.type} vs zod ${z_.base}`,
        ).toContain(attr.type);
      }
    }
  });
});
