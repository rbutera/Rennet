import { describe, expect, it } from "vitest";
import { type GrillSpecSource, parseGrillSpec } from "./grill-spec";

/** Narrow an optional to present, or fail the test loudly (no non-null assertions). */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a present value");
  return value;
}

// The fixtures are the exact markdown shapes grill-with-docs documents take: an MADR-
// style ADR (a `#` title, a rationale, a `## Considered Options` list) and a
// `CONTEXT.md` with a `## Language` glossary carrying `**term**: definition` /
// `_Avoid_:` entries, plus a context-map table. They are the shapes the obligation
// parser's grill branch reads, so this rich parser is exercised against the same input.

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

const CONTEXT_MD = `# Project glossary

## Language

Words this project uses precisely.

### Review objects

- **Patchset**: the immutable capture of a change under review, addressed by its
  head OID.
  _Avoid_: diff, changeset

- **Board**: the readable object a lens renders from a patchset.
  _Avoid_: canvas, panel

### Roles

- **Seat**: a single provider turn in a lens run.

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Runtime | Node 22 | LTS, native fetch |
| Bundler | Vite | Nx inference plugin |
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
  it("extracts grouped terms with definition, avoid list, and source line", () => {
    const spec = parseGrillSpec({ contextDocs: [{ path: "CONTEXT.md", md: CONTEXT_MD }] });
    const byTerm = new Map(spec.glossary.map((entry) => [entry.term, entry]));

    const patchset = present(byTerm.get("Patchset"));
    expect(patchset.definition).toBe(
      "the immutable capture of a change under review, addressed by its head OID.",
    );
    expect(patchset.avoid).toEqual(["diff", "changeset"]);
    expect(patchset.group).toBe("Review objects");

    const board = present(byTerm.get("Board"));
    expect(board.avoid).toEqual(["canvas", "panel"]);
    expect(board.group).toBe("Review objects");
  });

  it("keeps avoid empty (not invented) for a term that states no `_Avoid_`", () => {
    const spec = parseGrillSpec({ contextDocs: [{ path: "CONTEXT.md", md: CONTEXT_MD }] });
    const seat = present(spec.glossary.find((entry) => entry.term === "Seat"));
    expect(seat.definition).toBe("a single provider turn in a lens run.");
    expect(seat.avoid).toEqual([]);
    expect(seat.group).toBe("Roles");
  });

  it("finds no glossary without a `## Language` section", () => {
    const spec = parseGrillSpec({
      contextDocs: [{ path: "CONTEXT.md", md: "# Notes\n\n**Patchset**: a thing.\n" }],
    });
    expect(spec.glossary).toEqual([]);
  });
});

describe("parseGrillSpec — context-map tables", () => {
  it("records each table's headers and rows with per-row source lines", () => {
    const spec = parseGrillSpec({ contextDocs: [{ path: "CONTEXT.md", md: CONTEXT_MD }] });
    expect(spec.contextMaps).toHaveLength(1);
    const map = present(spec.contextMaps[0]);
    expect(map.heading).toBe("Tech Stack");
    expect(map.headers).toEqual(["Layer", "Technology", "Rationale"]);
    expect(map.rows.map((row) => row.cells)).toEqual([
      ["Runtime", "Node 22", "LTS, native fetch"],
      ["Bundler", "Vite", "Nx inference plugin"],
    ]);
    // Rows carry distinct source lines so each is a distinct disposition anchor.
    const lines = map.rows.map((row) => row.source.line);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe("parseGrillSpec — sparse and absent input", () => {
  it("returns three empty arrays for an empty source (absence, not invention)", () => {
    expect(parseGrillSpec({})).toEqual({ decisions: [], glossary: [], contextMaps: [] });
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

  it("does not mistake a table inside a fenced code block for a context map", () => {
    const md = "# Doc\n\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n";
    expect(parseGrillSpec({ contextDocs: [{ path: "CONTEXT.md", md }] }).contextMaps).toEqual([]);
  });
});

// Positive control: mutate the input so the assertions above MUST redden. Each leg
// changes the source in a way a working parser reflects — proving the tests are not
// vacuous. (Run in this suite so a broken parser and a broken control both surface.)
describe("parseGrillSpec — positive control", () => {
  const source: GrillSpecSource = {
    adrs: [{ path: "docs/adr/0007-reviewed-tree.md", md: ADR_MD }],
    contextDocs: [{ path: "CONTEXT.md", md: CONTEXT_MD }],
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
    const withoutAvoid = CONTEXT_MD.replace(/\n\s*_Avoid_: diff, changeset/, "");
    const spec = parseGrillSpec({ contextDocs: [{ path: "CONTEXT.md", md: withoutAvoid }] });
    const patchset = present(spec.glossary.find((entry) => entry.term === "Patchset"));
    expect(patchset.avoid).toEqual([]);
    // Control: the unmutated fixture carries the avoid list.
    const original = present(
      parseGrillSpec(source).glossary.find((entry) => entry.term === "Patchset"),
    );
    expect(original.avoid).toEqual(["diff", "changeset"]);
  });
});
