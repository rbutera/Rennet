import { describe, expect, it } from "vitest";
import { type GrillSpecSource, parseGrillSpec } from "./grill-spec";

/** Narrow an optional to present, or fail the test loudly (no non-null assertions). */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a present value");
  return value;
}

// The fixtures are the EXACT on-disk shapes grill-with-docs (domain-modeling) writes,
// per docs/developing/reference/spec-formats/grill-with-docs.md: an ADR (a `#` title,
// a rationale, an optional `## Considered Options` list); a `CONTEXT.md` `## Language`
// glossary whose entries are a `**term**:` line, the definition on the NEXT line, and
// an `_Avoid_: a, b` line; and — multi-context only — a `CONTEXT-MAP.md` with a
// `## Contexts` link-list and a `## Relationships` directional-edge list. There is no
// context-map "table" in this format; the earlier fixture invented one.

const ADR_MD = `# Store the reviewed tree as an immutable Git object

A local review must render the exact bytes the reviewer saw, not whatever the disk
holds when the board opens later.

## Context

Working-tree reviews mutate as the user keeps editing.

## Considered Options

- Pin a full Git tree object at capture (\`reviewedTreeOid\`)
- Re-read the working tree on open
- Snapshot the changed files into the review store

## Decision Outcome

Pin the tree object: it is immutable and cheap to address.
`;

const THIN_ADR_MD = `# Adopt Base UI over Radix

Radix pulls a heavier tree and forks our theming.
`;

// A real CONTEXT.md: term key on one line, definition on the next, then `_Avoid_`.
// Grouped under `###` subheadings, and one term with no `_Avoid_` (Customer).
const CONTEXT_MD = `# Ordering

Receives and tracks customer orders through to dispatch.

## Language

### Orders

**Order**:
A customer's request for goods, from placement to dispatch.
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

### People

**Customer**:
A person or organization that places orders.
`;

// A real CONTEXT-MAP.md: a `## Contexts` link-list and a `## Relationships` edge-list.
const CONTEXT_MAP_MD = `# System context map

The bounded contexts and how they relate.

## Contexts

- [Ordering](src/ordering/CONTEXT.md) - Receives and tracks customer orders
- [Billing](src/billing/CONTEXT.md) - Issues invoices and records payments
- [Fulfillment](src/fulfillment/CONTEXT.md)

## Relationships

- Ordering → Fulfillment
- Ordering ↔ Billing: shares customer identity
`;

describe("parseGrillSpec — ADRs", () => {
  it("extracts the decision, verbatim rationale, and considered options in source order", () => {
    const spec = parseGrillSpec({ adrs: [{ path: "docs/adr/0007-reviewed-tree.md", md: ADR_MD }] });
    expect(spec.decisions).toHaveLength(1);
    const decision = present(spec.decisions[0]);
    expect(decision.title).toBe("Store the reviewed tree as an immutable Git object");
    expect(decision.rationale).toBe(
      "A local review must render the exact bytes the reviewer saw, not whatever the disk holds when the board opens later.",
    );
    expect(decision.alternatives).toEqual([
      "Pin a full Git tree object at capture (`reviewedTreeOid`)",
      "Re-read the working tree on open",
      "Snapshot the changed files into the review store",
    ]);
    // The rationale stops at the first `##` — the Context/Decision Outcome prose is not folded in.
    expect(decision.rationale).not.toContain("Working-tree reviews mutate");
    expect(decision.rationale).not.toContain("Pin the tree object");
    expect(decision.source).toEqual({ path: "docs/adr/0007-reviewed-tree.md", line: 1 });
  });

  it("keeps alternatives empty (not invented) when the ADR lists no considered options", () => {
    const spec = parseGrillSpec({ adrs: [{ path: "docs/decisions/base-ui.md", md: THIN_ADR_MD }] });
    const decision = present(spec.decisions[0]);
    expect(decision.title).toBe("Adopt Base UI over Radix");
    expect(decision.rationale).toBe("Radix pulls a heavier tree and forks our theming.");
    expect(decision.alternatives).toEqual([]);
  });

  it("yields no decision from a document with no `#` title", () => {
    expect(
      parseGrillSpec({ adrs: [{ path: "docs/adr/notes.md", md: "## Only a subsection\n" }] })
        .decisions,
    ).toEqual([]);
  });
});

describe("parseGrillSpec — CONTEXT.md glossary", () => {
  it("extracts grouped terms (definition on the next line), avoid list, and source line", () => {
    const spec = parseGrillSpec({ contextDocs: [{ path: "CONTEXT.md", md: CONTEXT_MD }] });
    const byTerm = new Map(spec.glossary.map((entry) => [entry.term, entry]));

    const order = present(byTerm.get("Order"));
    expect(order.definition).toBe("A customer's request for goods, from placement to dispatch.");
    expect(order.avoid).toEqual(["Purchase", "transaction"]);
    expect(order.group).toBe("Orders");
    // The `**Order**:` line is line 9 (1-based) of the fixture.
    expect(order.source).toEqual({ path: "CONTEXT.md", line: 9 });

    const invoice = present(byTerm.get("Invoice"));
    expect(invoice.avoid).toEqual(["Bill", "payment request"]);
    expect(invoice.group).toBe("Orders");
  });

  it("keeps avoid empty (not invented) for a term that states no `_Avoid_`", () => {
    const spec = parseGrillSpec({ contextDocs: [{ path: "CONTEXT.md", md: CONTEXT_MD }] });
    const customer = present(spec.glossary.find((entry) => entry.term === "Customer"));
    expect(customer.definition).toBe("A person or organization that places orders.");
    expect(customer.avoid).toEqual([]);
    expect(customer.group).toBe("People");
  });

  it("finds no glossary without a `## Language` section", () => {
    const spec = parseGrillSpec({
      contextDocs: [{ path: "CONTEXT.md", md: "# Notes\n\n**Order**:\na thing.\n" }],
    });
    expect(spec.glossary).toEqual([]);
  });
});

describe("parseGrillSpec — CONTEXT-MAP.md", () => {
  it("extracts contexts (name, href, summary) and directional relationships", () => {
    const spec = parseGrillSpec({
      contextMaps: [{ path: "CONTEXT-MAP.md", md: CONTEXT_MAP_MD }],
    });
    expect(spec.contextMaps).toHaveLength(1);
    const map = present(spec.contextMaps[0]);

    expect(map.contexts).toEqual([
      {
        name: "Ordering",
        href: "src/ordering/CONTEXT.md",
        summary: "Receives and tracks customer orders",
        source: { path: "CONTEXT-MAP.md", line: 7 },
      },
      {
        name: "Billing",
        href: "src/billing/CONTEXT.md",
        summary: "Issues invoices and records payments",
        source: { path: "CONTEXT-MAP.md", line: 8 },
      },
      {
        // No summary stated — the field is absent, not an empty string.
        name: "Fulfillment",
        href: "src/fulfillment/CONTEXT.md",
        source: { path: "CONTEXT-MAP.md", line: 9 },
      },
    ]);

    expect(map.relationships).toEqual([
      {
        from: "Ordering",
        to: "Fulfillment",
        direction: "->",
        source: { path: "CONTEXT-MAP.md", line: 13 },
      },
      {
        from: "Ordering",
        to: "Billing",
        direction: "<->",
        label: "shares customer identity",
        source: { path: "CONTEXT-MAP.md", line: 14 },
      },
    ]);
  });

  it("normalises a reversed arrow by swapping from/to", () => {
    const md = "# Map\n\n## Relationships\n\n- Fulfillment ← Ordering\n";
    const map = present(
      parseGrillSpec({ contextMaps: [{ path: "CONTEXT-MAP.md", md }] }).contextMaps[0],
    );
    expect(map.relationships).toEqual([
      {
        from: "Ordering",
        to: "Fulfillment",
        direction: "->",
        source: { path: "CONTEXT-MAP.md", line: 5 },
      },
    ]);
  });

  it("does not split a hyphenated context name on its hyphen", () => {
    const md = "# Map\n\n## Relationships\n\n- Order-Management -> Fulfillment\n";
    const map = present(
      parseGrillSpec({ contextMaps: [{ path: "CONTEXT-MAP.md", md }] }).contextMaps[0],
    );
    const edge = present(map.relationships[0]);
    expect(edge.from).toBe("Order-Management");
    expect(edge.to).toBe("Fulfillment");
    expect(edge.direction).toBe("->");
  });

  it("emits an empty map (presence is the multi-context signal) when sections are absent", () => {
    const map = present(
      parseGrillSpec({ contextMaps: [{ path: "CONTEXT-MAP.md", md: "# Map\n\nprose only\n" }] })
        .contextMaps[0],
    );
    expect(map.contexts).toEqual([]);
    expect(map.relationships).toEqual([]);
  });
});

describe("parseGrillSpec — raw source (#239)", () => {
  it("carries every source document verbatim, in reading order", () => {
    const source: GrillSpecSource = {
      adrs: [{ path: "docs/adr/0007-reviewed-tree.md", md: ADR_MD }],
      contextDocs: [{ path: "CONTEXT.md", md: CONTEXT_MD }],
      contextMaps: [{ path: "CONTEXT-MAP.md", md: CONTEXT_MAP_MD }],
    };
    const spec = parseGrillSpec(source);
    expect(spec.raw.adrs).toEqual([{ path: "docs/adr/0007-reviewed-tree.md", md: ADR_MD }]);
    expect(spec.raw.contextDocs).toEqual([{ path: "CONTEXT.md", md: CONTEXT_MD }]);
    expect(spec.raw.contextMaps).toEqual([{ path: "CONTEXT-MAP.md", md: CONTEXT_MAP_MD }]);
    // Verbatim, not a re-serialization: prose the parser drops still rides along.
    expect(present(spec.raw.contextMaps[0]).md).toContain(
      "The bounded contexts and how they relate.",
    );
    expect(present(spec.raw.adrs[0]).md).toContain("## Decision Outcome");
  });
});

describe("parseGrillSpec — sparse and absent input", () => {
  it("returns empty arrays and empty raw for an empty source (absence, not invention)", () => {
    expect(parseGrillSpec({})).toEqual({
      decisions: [],
      glossary: [],
      contextMaps: [],
      raw: { adrs: [], contextDocs: [], contextMaps: [] },
    });
  });

  it("returns empty arrays for documents that carry nothing structured", () => {
    const spec = parseGrillSpec({
      adrs: [{ path: "docs/adr/empty.md", md: "\n\n" }],
      contextDocs: [{ path: "CONTEXT.md", md: "# Just a heading\n\nSome prose.\n" }],
    });
    expect(spec.decisions).toEqual([]);
    expect(spec.glossary).toEqual([]);
    expect(spec.contextMaps).toEqual([]);
  });

  it("does not treat a relationships list inside a fenced code block as edges", () => {
    const md = "# Map\n\n## Relationships\n\n```\n- Ordering -> Billing\n```\n";
    const map = present(
      parseGrillSpec({ contextMaps: [{ path: "CONTEXT-MAP.md", md }] }).contextMaps[0],
    );
    expect(map.relationships).toEqual([]);
  });
});

// Positive control: mutate the input so the assertions above MUST redden. Each leg
// changes the source in a way a working parser reflects — proving the tests are not
// vacuous. (Run in this suite so a broken parser and a broken control both surface.)
describe("parseGrillSpec — positive control", () => {
  const source: GrillSpecSource = {
    adrs: [{ path: "docs/adr/0007-reviewed-tree.md", md: ADR_MD }],
    contextDocs: [{ path: "CONTEXT.md", md: CONTEXT_MD }],
    contextMaps: [{ path: "CONTEXT-MAP.md", md: CONTEXT_MAP_MD }],
  };

  it("reflects a removed considered-options section (alternatives go empty)", () => {
    const withoutOptions = ADR_MD.replace(
      /## Considered Options[\s\S]*?## Decision Outcome/,
      "## Decision Outcome",
    );
    const spec = parseGrillSpec({
      adrs: [{ path: "docs/adr/0007-reviewed-tree.md", md: withoutOptions }],
    });
    // The control: the real fixture DOES have alternatives; this mutated one does not.
    expect(present(parseGrillSpec(source).decisions[0]).alternatives.length).toBeGreaterThan(0);
    expect(present(spec.decisions[0]).alternatives).toEqual([]);
  });

  it("reflects a dropped `_Avoid_` line (avoid goes empty)", () => {
    const withoutAvoid = CONTEXT_MD.replace(/\n_Avoid_: Purchase, transaction/, "");
    const spec = parseGrillSpec({ contextDocs: [{ path: "CONTEXT.md", md: withoutAvoid }] });
    const order = present(spec.glossary.find((entry) => entry.term === "Order"));
    expect(order.avoid).toEqual([]);
    // Control: the unmutated fixture carries the avoid list.
    const original = present(
      parseGrillSpec(source).glossary.find((entry) => entry.term === "Order"),
    );
    expect(original.avoid).toEqual(["Purchase", "transaction"]);
  });

  it("reflects a dropped relationship edge (one fewer edge)", () => {
    const withoutEdge = CONTEXT_MAP_MD.replace(/\n- Ordering → Fulfillment/, "");
    const spec = parseGrillSpec({ contextMaps: [{ path: "CONTEXT-MAP.md", md: withoutEdge }] });
    expect(present(spec.contextMaps[0]).relationships).toHaveLength(1);
    // Control: the unmutated fixture carries both edges.
    expect(present(parseGrillSpec(source).contextMaps[0]).relationships).toHaveLength(2);
  });
});
