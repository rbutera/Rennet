import type { Author, BoardTool, DraftElement } from "@rennet/protocol";
import { boardToolsByName } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  type BoardToolResult,
  BoardWriter,
  type BoardWriterOptions,
  type FinishPointer,
} from "./board-writer";
import type { ChangedRegion, LintContext, LintTarget } from "./lint";

/**
 * The board writer: host-minted ids, a child naming its parent, references that must
 * name what the board holds, boundary refusals, `cite`, and `finish`.
 *
 * Every "cannot be constructed" claim here is proven by ATTEMPTING it through the tool
 * surface and reading the refusal — never by asserting a property of a board the test
 * built by hand.
 */

const author: Author = { kind: "lens-agent", id: "seat-under-test" };

const REGIONS: ChangedRegion[] = [
  { path: "src/auth.ts", side: "head", start: 10, end: 14 },
  { path: "src/util.ts", side: "head", start: 1, end: 3 },
  { path: "src/legacy.ts", side: "base", start: 40, end: 44 },
];

// The writer takes patchset knowledge WITHOUT a lens: the lens is the target, and the
// writer sets it. So this fixture cannot name one either.
type WriterLint = Omit<LintContext, "lens">;

const lintCtx = (over: Partial<WriterLint> = {}): WriterLint => ({
  regions: REGIONS,
  files: new Map([
    ["src/auth.ts", 200],
    ["src/util.ts", 50],
    ["pnpm-lock.yaml", 9000],
  ]),
  // `src/util.ts` is in the BASE inventory and has no base-side region, which is the
  // fixture the "no changed lines on that side" case needs: the file exists, so
  // `citation-resolves` says nothing, and the only answer left is the empty side.
  baseFiles: new Map([
    ["src/legacy.ts", 120],
    ["src/util.ts", 50],
  ]),
  ...over,
});

const writer = (target: LintTarget = "flagged", over: Partial<BoardWriterOptions> = {}) => {
  const { lint: lintOver, ...rest } = over;
  return new BoardWriter({
    target,
    author,
    lint: { ...lintCtx(), ...(lintOver ?? {}) },
    ...rest,
  });
};

/** Unwrap a call that must have succeeded, so a refusal fails loudly with its text. */
function ok(result: BoardToolResult): Extract<BoardToolResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected success, got refusal: ${result.refusal}`);
  return result;
}

/** The id an `add`/`cite`/`update` returned. */
function idOf(result: BoardToolResult): string {
  const outcome = ok(result).outcome;
  if (outcome.kind !== "element") throw new Error(`expected an element id, got ${outcome.kind}`);
  return outcome.id;
}

function refusalOf(result: BoardToolResult): string {
  if (result.ok) throw new Error("expected a refusal, got a successful call");
  return result.refusal;
}

function pointersOf(result: BoardToolResult): readonly FinishPointer[] {
  const outcome = ok(result).outcome;
  return outcome.kind === "pointers" ? outcome.pointers : [];
}

const elementById = (w: BoardWriter, id: string): DraftElement | undefined =>
  w.board().elements.find((element) => element.id === id);

/** The element, or a loud failure — so an assertion never reads through a missing one. */
function heldElement(w: BoardWriter, id: string): DraftElement {
  const element = elementById(w, id);
  if (element === undefined) throw new Error(`the board does not hold \`${id}\``);
  return element;
}

const dataOf = <T>(w: BoardWriter, id: string): T => heldElement(w, id).data as T;

// ── 1.4 Host-minted ids, parenting, and the host's `children` ────────────────

describe("the host mints ids and a child names its parent (D4)", () => {
  it("a creating call returns an id the seat never chose", () => {
    const w = writer();
    const first = idOf(w.call("add_section", { title: "What changed" }));
    const second = idOf(
      w.call("add_prose", { markdown: "The refresh path moved.", parent_id: first }),
    );
    expect(first).not.toBe(second);
    // The seat passed no id on either call; both came back from the host.
    expect(w.board().elements.map((element) => element.id)).toEqual([first, second]);
  });

  it("the host maintains `children` from the parent each call names", () => {
    const w = writer();
    const section = idOf(w.call("add_section", { title: "What changed" }));
    const a = idOf(w.call("add_prose", { markdown: "First.", parent_id: section }));
    const b = idOf(w.call("add_prose", { markdown: "Second.", parent_id: section }));
    // `children` is on no tool input; it is here because the host put it here, in the
    // order the calls arrived.
    expect(dataOf<{ children: string[] }>(w, section).children).toEqual([a, b]);
  });

  it("two writers with different id prefixes mint ids that cannot collide", () => {
    // NOT the D9 scenario yet: these are two writers each holding its OWN elements, so
    // this asserts the prefix, not that two seats can write one board. Flagged's two
    // voices share a board in group 3, and the shared-board case belongs to that change.
    const claude = writer("flagged", { idPrefix: "a" });
    const codex = writer("flagged", { idPrefix: "b" });
    const one = idOf(claude.call("add_section", { title: "Correctness" }));
    const two = idOf(codex.call("add_section", { title: "Correctness" }));
    expect(one).not.toBe(two);
    expect(one.startsWith("a")).toBe(true);
    expect(two.startsWith("b")).toBe(true);
  });

  it("a parent the board does not hold is refused, saying what it does hold", () => {
    const w = writer();
    const held = idOf(w.call("add_section", { title: "What changed" }));
    const refusal = refusalOf(w.call("add_prose", { markdown: "Orphan.", parent_id: "nope" }));
    expect(refusal).toContain("nope");
    expect(refusal).toContain(held);
    expect(w.board().elements).toHaveLength(1);
  });

  it("a parent that holds no children is refused by kind", () => {
    const w = writer();
    const prose = idOf(w.call("add_prose", { markdown: "Not a container." }));
    const refusal = refusalOf(w.call("add_prose", { markdown: "Child.", parent_id: prose }));
    expect(refusal).toContain("holds no children");
    expect(refusal).toContain("section or a step");
  });
});

describe("a reference argument is refused when the board does not hold it (D4)", () => {
  it("a finding citing an id the board has never minted is refused, and no element is created", () => {
    const w = writer();
    const before = w.board().elements.length;
    const refusal = refusalOf(
      w.call("add_finding", {
        severity: "high",
        concern: "The refresh token is classified before its code is read.",
        code_ref_ids: ["c-does-not-exist"],
      }),
    );
    expect(refusal).toContain("code_ref_ids");
    expect(refusal).toContain("c-does-not-exist");
    expect(refusal).toContain("the board is empty");
    expect(w.board().elements).toHaveLength(before);
  });

  it("the refusal lists the ids the board does hold", () => {
    const w = writer();
    const cited = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 11, end_line: 12 }),
    );
    const refusal = refusalOf(
      w.call("add_finding", {
        severity: "low",
        concern: "Something.",
        code_ref_ids: [cited, "ghost"],
      }),
    );
    expect(refusal).toContain("ghost");
    expect(refusal).toContain(cited);
  });

  // The two structural claims, each proven by attempting the thing.
  it("a dangling reference is unconstructible: every attempt to make one is refused", () => {
    const w = writer("decisions");
    const ref = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 11, end_line: 12 }),
    );
    const decision = idOf(
      w.call("add_decision", {
        statement: "Refresh is decided before classification.",
        why: "The classifier reads a code the refresh path has already consumed.",
        evidence_ref_ids: [ref],
        alternative_ids: [ref],
      }),
    );

    // (a) referencing an id that was never minted
    expect(
      refusalOf(
        w.call("add_decision", {
          statement: "A second call.",
          why: "Because.",
          evidence_ref_ids: ["never-minted"],
          alternative_ids: [ref],
        }),
      ),
    ).toContain("never-minted");

    // (b) updating a live element to point at an id that was never minted
    expect(
      refusalOf(w.call("update_decision", { element_id: decision, evidence_ref_ids: ["gone"] })),
    ).toContain("gone");

    // (c) removing the element something still cites — the reference would dangle,
    //     so the removal itself is refused and names the rule that refused it.
    const removal = refusalOf(w.call("remove_element", { element_id: ref }));
    expect(removal).toContain("element-reference-resolves");
    expect(elementById(w, ref)).toBeDefined();

    // Nothing on the board dangles. Note what did the work: the boundary tier ran on
    // every one of those calls, and `element-reference-resolves` is what refused (c) —
    // the earlier version of this comment claimed no rule was run, while the assertion
    // above depends on that exact rule's message. "Unconstructible through the tools"
    // means every path that would build one is refused, not that nothing checks.
    const ids = new Set(w.board().elements.map((element) => element.id));
    for (const element of w.board().elements) {
      for (const value of Object.values(element.data as Record<string, unknown>)) {
        for (const candidate of Array.isArray(value) ? value : [value]) {
          if (typeof candidate === "string" && candidate.startsWith("e")) {
            expect(ids.has(candidate) || candidate === element.id).toBe(true);
          }
        }
      }
    }
  });

  it("a reference cycle is unconstructible: an update that closes a loop is refused", () => {
    // The boundary does not constrain what KIND a reference names — `checkReferences`
    // asks only whether the board holds the id — so `alternative_ids`,
    // `evidence_ref_ids`, `scenario_ids`, `trace_ref_ids` and `code_ref_ids` can each
    // name an ancestor section and close a loop through the host-maintained `children`
    // edge, which is the one edge that runs forward. This is the UPDATE path; the add
    // path is the test below.
    const w = writer("decisions");
    const section = idOf(w.call("add_section", { title: "Storage" }));
    const ref = idOf(
      w.call("cite", { path: "src/util.ts", side: "head", start_line: 1, end_line: 2 }),
    );
    const decision = idOf(
      w.call("add_decision", {
        statement: "Storage stays on the caller.",
        why: "The alternative moved the lifetime into a shared cache.",
        evidence_ref_ids: [ref],
        alternative_ids: [ref],
        parent_id: section,
      }),
    );
    // section --children--> decision --alternatives--> section  is a cycle.
    const refusal = refusalOf(
      w.call("update_decision", { element_id: decision, alternative_ids: [section] }),
    );
    expect(refusal).toContain("cycle");
    // Name what refuses it: the boundary tier's `element-reference-resolves`, which is
    // the mechanism D5 assigns and the one the control below removes.
    expect(refusal).toContain("element-reference-resolves");
    // …and the board still carries the reference it had.
    expect(dataOf<{ alternatives: string[] }>(w, decision).alternatives).toEqual([ref]);
  });

  it("a reference cycle is unconstructible on the ADD path too, through evidence", () => {
    // The same loop, closed by the call that CREATES the element rather than by a later
    // update, and through a different reference field — so the guard is not something
    // only `update_*` happens to run.
    const w = writer("decisions");
    const section = idOf(w.call("add_section", { title: "Storage" }));
    const refusal = refusalOf(
      w.call("add_decision", {
        statement: "Storage stays on the caller.",
        why: "The alternative moved the lifetime into a shared cache.",
        // section --children--> (this decision) --evidence--> section
        evidence_ref_ids: [section],
        alternative_ids: [section],
        parent_id: section,
      }),
    );
    expect(refusal).toContain("cycle");
    expect(refusal).toContain("element-reference-resolves");
    // Nothing was created, and the id the refused call would have taken is not spent.
    expect(w.board().elements).toHaveLength(1);
    const next = idOf(
      w.call("cite", { path: "src/util.ts", side: "head", start_line: 1, end_line: 2 }),
    );
    expect(next).toBe("e2");
  });

  it("positive control: an add whose reference IS held goes through", () => {
    // The refusals above are worth nothing unless the same shapes succeed when the
    // reference resolves — otherwise every assertion could be satisfied by a writer
    // that refuses everything.
    const w = writer("decisions");
    const ref = idOf(
      w.call("cite", { path: "src/util.ts", side: "head", start_line: 1, end_line: 2 }),
    );
    const decision = idOf(
      w.call("add_decision", {
        statement: "Storage stays on the caller.",
        why: "The alternative moved the lifetime into a shared cache.",
        evidence_ref_ids: [ref],
        alternative_ids: [ref],
      }),
    );
    expect(elementById(w, decision)).toBeDefined();
  });
});

// ── 1.6 Boundary refusals ───────────────────────────────────────────────────

describe("a boundary rule is a refusal in the same call, naming the field", () => {
  it("code bytes in prose are refused and the board holds no such element", () => {
    const w = writer();
    const refusal = refusalOf(
      w.call("add_prose", { markdown: "Here it is:\n```ts\nconst x = 1;\n```\n" }),
    );
    expect(refusal).toContain("no-code-bytes");
    expect(refusal).toContain("markdown");
    expect(refusal).toContain("`code_ref`");
    expect(w.board().elements).toHaveLength(0);
  });

  it("machinery vocabulary in a structural field is refused, naming what is admissible", () => {
    const w = writer();
    const refusal = refusalOf(w.call("add_section", { title: "What the lens found" }));
    expect(refusal).toContain("process-vocabulary");
    expect(refusal).toContain("Name the domain object, not the pipeline");
    expect(w.board().elements).toHaveLength(0);
  });

  it("a decision with no evidence and no alternative is refused at the call", () => {
    const w = writer("decisions");
    const refusal = refusalOf(
      w.call("add_decision", {
        statement: "We picked a queue.",
        why: "It was there.",
        evidence_ref_ids: [],
        alternative_ids: [],
      }),
    );
    expect(refusal).toContain("decision-grounded");
    expect(refusal).toContain("evidence");
    expect(refusal).toContain("alternatives");
  });

  it("a refusal is not a crash and not an attempt: the writer keeps going", () => {
    const w = writer();
    for (let i = 0; i < 10; i += 1) {
      expect(w.call("add_prose", { markdown: "```\nnope\n```" }).ok).toBe(false);
    }
    expect(w.status()).toBe("drafting");
    const section = idOf(w.call("add_section", { title: "Refresh handling" }));
    expect(elementById(w, section)).toBeDefined();
  });

  it("a kind this lens does not author has no verb at all", () => {
    // `kind-allowlist` is in the boundary tier and never fires, because the surface
    // carries no verb for a foreign kind. That is the difference between a rule that
    // refuses and a shape that cannot be written.
    const w = writer("sequence");
    expect(w.toolNames()).not.toContain("add_finding");
    expect(refusalOf(w.call("add_finding", { severity: "high", concern: "x" }))).toContain(
      "There is no `add_finding` on this board",
    );
  });
});

// ── 1.7 The citing verb ─────────────────────────────────────────────────────

describe("cite resolves against the captured patchset in the same call", () => {
  it("a citation inside a changed region resolves and returns a reference", () => {
    const w = writer();
    const id = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 11, end_line: 13 }),
    );
    const element = heldElement(w, id);
    expect(element.kind).toBe("code_ref");
    expect((element.data as { start_line: number }).start_line).toBe(11);
    // Host-owned: the seat is never told the capture's id, so it is absent on the draft.
    expect((element.data as { patchset_id?: string }).patchset_id).toBeUndefined();
  });

  it("outside the change: refused with the nearest changed range on that path and side", () => {
    const w = writer();
    const refusal = refusalOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 120, end_line: 130 }),
    );
    expect(refusal).toContain("unresolvable-citation");
    expect(refusal).toContain("lies outside the change");
    // The nearest changed range, so the seat can move the citation in one more call.
    expect(refusal).toContain("src/auth.ts:10-14");
    expect(w.board().elements).toHaveLength(0);
  });

  it("no changed lines on that side: refused saying exactly that", () => {
    const w = writer();
    // `src/util.ts` changed on head only, so a base-side citation has no region to hit
    // and the refusal cannot offer a nearest range — it has to say the side is empty.
    const nothingChanged = refusalOf(
      w.call("cite", { path: "src/util.ts", side: "base", start_line: 1, end_line: 2 }),
    );
    expect(nothingChanged).toContain("no changed lines on the base side");
    expect(nothingChanged).not.toContain("nearest changed range");
    // …and ONLY that. The file is in the base inventory, so `citation-resolves` has
    // nothing to say; without it there the refusal carried a "no such file" report too
    // and this test passed while testing a different case.
    expect(nothingChanged).not.toContain("no such file");
    expect(nothingChanged).not.toContain("citation-resolves");
  });

  it("an inverted range is refused, naming the inputs and not a rolled-back id", () => {
    const w = writer();
    const refusal = refusalOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 14, end_line: 10 }),
    );
    expect(refusal).toContain("citation-resolves");
    expect(refusal).toContain("inverted");
    // Task 1.6: a refusal names the FIELD. The element id the host minted for this call
    // was rolled back, so naming it would point the seat at nothing it has ever seen.
    for (const field of ["`path`", "`side`", "`start_line`", "`end_line`"]) {
      expect(refusal).toContain(field);
    }
    expect(refusal).not.toMatch(/`e\d+`/);
  });

  it("a refusal against another element keeps that element's ref, because it is real", () => {
    // The translation above applies only to the element THIS call touched. An element
    // already on the board is addressable, so its id is the useful pointer.
    const w = writer("decisions");
    const ref = idOf(
      w.call("cite", { path: "src/util.ts", side: "head", start_line: 1, end_line: 2 }),
    );
    idOf(
      w.call("add_decision", {
        statement: "Storage stays on the caller.",
        why: "The alternative moved the lifetime into a shared cache.",
        evidence_ref_ids: [ref],
        alternative_ids: [ref],
      }),
    );
    const refusal = refusalOf(w.call("remove_element", { element_id: ref }));
    expect(refusal).toContain("element-reference-resolves");
    expect(refusal).toMatch(/`e\d+/);
  });

  it("a scaffold path is refused on every seat but Noise", () => {
    const flagged = writer("flagged");
    const refusal = refusalOf(
      flagged.call("cite", {
        path: "pnpm-lock.yaml",
        side: "head",
        start_line: 1,
        end_line: 2,
      }),
    );
    expect(refusal).toContain("scaffold-is-noise-lane");
    expect(refusal).toContain("pnpm-lock.yaml");

    // The same call on the Noise seat is the lane it belongs to. Without this the
    // assertion above would be satisfied by a writer that refuses lockfiles outright.
    const noise = writer("noise", {
      lint: {
        regions: [...REGIONS, { path: "pnpm-lock.yaml", side: "head", start: 1, end: 4000 }],
        files: new Map([["pnpm-lock.yaml", 9000]]),
      },
    });
    expect(
      noise.call("cite", { path: "pnpm-lock.yaml", side: "head", start_line: 1, end_line: 2 }).ok,
    ).toBe(true);
  });
});

// ── 1.6 finish ──────────────────────────────────────────────────────────────

describe("finish is the whole-board verdict and returns pointers only", () => {
  it("an empty board does not finish: the emptiness check moved here", () => {
    const w = writer("flagged");
    const pointers = pointersOf(w.call("finish"));
    expect(pointers.map((pointer) => pointer.ruleId)).toContain("board-has-material");
    expect(w.status()).toBe("drafting");
  });

  it("a board holding one orphaned step comes back as exactly one pointer", () => {
    // The COMPLETE list, not a filtered one. It used to add a second, reachable step and
    // then filter by rule id, so it never tested the case its name describes — and the
    // case it avoided returned TWO pointers, because the emptiness rule counted only
    // reachable steps and reported `/elements` as well. "The board is empty" over a
    // board with a step on it is a false statement, so material presence now counts
    // what exists and reachability answers for itself.
    const w = writer("sequence");
    const span = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 11, end_line: 12 }),
    );
    const orphan = idOf(w.call("add_step", { title: "Read the refresh path", span_ref_id: span }));

    const pointers = pointersOf(w.call("finish"));
    expect(pointers).toHaveLength(1);
    expect(pointers[0]?.ruleId).toBe("sequence-step-reachable");
    expect(pointers[0]?.elementRef).toBe(orphan);
    expect(w.status()).toBe("drafting");

    // The seat answers the pointer with further calls in the same turn, and finishes.
    const section = idOf(w.call("add_section", { title: "Start with refresh" }));
    ok(w.call("remove_element", { element_id: orphan }));
    ok(
      w.call("add_step", { title: "Read the refresh path", span_ref_id: span, parent_id: section }),
    );
    const settled = ok(w.call("finish")).outcome;
    expect(settled.kind).toBe("settled");
    expect(w.status()).toBe("settled");
  });

  it("an empty Sequence board reports emptiness alone, and never both", () => {
    // The other side of the same split: with no step at all it is the emptiness rule's
    // case, and reachability has nothing to name.
    const w = writer("sequence");
    const pointers = pointersOf(w.call("finish"));
    expect(pointers).toHaveLength(1);
    expect(pointers[0]?.ruleId).toBe("board-has-material");
    expect(pointers[0]?.elementRef).toBe("/elements");
  });

  it("a pointer carries a rule, an element and one sentence — no board, no draft", () => {
    // Point it at a board that HAS content, so the assertion is about what the pointer
    // leaves out rather than about a board with nothing to leave out.
    const w = writer("sequence");
    const span = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 11, end_line: 12 }),
    );
    const prose = "The refresh path is read before the classifier that consumes its code.";
    idOf(w.call("add_prose", { markdown: prose }));
    const orphan = idOf(w.call("add_step", { title: "Read the refresh path", span_ref_id: span }));

    const pointers = pointersOf(w.call("finish"));
    expect(pointers.length).toBeGreaterThan(0);
    for (const pointer of pointers) {
      expect(Object.keys(pointer).sort()).toEqual(["elementRef", "message", "ruleId"]);
      // Three strings. A pointer cannot carry a draft, because it has nowhere to put one.
      for (const value of Object.values(pointer)) expect(typeof value).toBe("string");
      // …and it does not quote the board back at the seat, which is already holding it.
      // The message itself stays: it is the correction, and it is the only part that
      // says WHAT rather than WHERE.
      expect(pointer.message).not.toContain(prose);
    }
    expect(pointers.some((pointer) => pointer.elementRef === orphan)).toBe(true);
  });

  it("settle_absent declares the lens's own absence and takes only a note", () => {
    const w = writer("noise");
    const outcome = ok(w.call("settle_absent", { note: "Every hunk carries meaning." })).outcome;
    expect(outcome).toEqual({
      kind: "absent",
      reason: "no-noise",
      note: "Every hunk carries meaning.",
    });
    expect(w.status()).toBe("absent");
  });

  it("a lens that admits no absence has no settle-absent verb to call", () => {
    const w = writer("sequence");
    expect(w.toolNames()).not.toContain("settle_absent");
    expect(refusalOf(w.call("settle_absent", { note: "nothing here" }))).toContain(
      "There is no `settle_absent` on this board",
    );
  });
});

describe("a list-valued field is written whole, or the call is refused", () => {
  // The defect this covers: `update_section {source_candidates:["c2"]}` returned ok and
  // left `sources: []`, because the rebuilt array was sized off a spine the call never
  // sent — while `update_*` tells the model "Only the fields given change." Two answers:
  // the list form no longer carries companions where they were only decoration, and what
  // remains is refused rather than silently rebuilt.

  it("a partial update does not wipe a list the call never mentioned", () => {
    const w = writer("design");
    const section = idOf(
      w.call("add_section", { title: "Refresh handling", source_paths: ["docs/a.md"] }),
    );
    expect(dataOf<{ sources: unknown[] }>(w, section).sources).toEqual([{ path: "docs/a.md" }]);

    // A call that says nothing about sources leaves them exactly as they were.
    ok(w.call("update_section", { element_id: section, title: "Refresh handling, revised" }));
    expect(dataOf<{ sources: unknown[] }>(w, section).sources).toEqual([{ path: "docs/a.md" }]);
    expect(dataOf<{ title: string }>(w, section).title).toBe("Refresh handling, revised");

    // …and a call that DOES name the list replaces it, which is what the list form means.
    ok(w.call("update_section", { element_id: section, source_paths: ["docs/b.md"] }));
    expect(dataOf<{ sources: unknown[] }>(w, section).sources).toEqual([{ path: "docs/b.md" }]);
  });

  it("the alignment companions are gone from the list form, and kept on the single form", () => {
    // A list of sources is `source_paths` alone: candidate and line were two optional
    // fields a seat had to keep index-aligned for no gain. On a requirement's SINGLE
    // source they carry weight and there is no index to align.
    const design = boardToolsByName("design");
    const sectionFields = Object.keys((design.get("add_section") as BoardTool).input.shape);
    expect(sectionFields).toContain("source_paths");
    expect(sectionFields).not.toContain("source_candidates");
    expect(sectionFields).not.toContain("source_lines");

    const requirementFields = Object.keys((design.get("add_requirement") as BoardTool).input.shape);
    expect(requirementFields).toEqual(
      expect.arrayContaining(["source_path", "source_candidate", "source_line"]),
    );
  });

  it("a companion without its spine is refused, naming both and what is admissible", () => {
    // `stats` keeps both parts, because a label with no value is not a stat — so this is
    // the shape the refusal still has to answer.
    const w = writer("design");
    const refusal = refusalOf(
      w.call("set_document", {
        title: "Design",
        intro_markdown: "Three requirements landed.",
        stat_values: ["3"],
      }),
    );
    expect(refusal).toContain("`stat_values`");
    expect(refusal).toContain("`stat_labels`");
    expect(refusal).toContain("written whole");
    expect(w.board().document).toBeUndefined();
  });

  it("a length mismatch is refused, saying which array is short and by how much", () => {
    const w = writer("design");
    const refusal = refusalOf(
      w.call("set_document", {
        title: "Design",
        intro_markdown: "Three requirements landed.",
        stat_labels: ["requirements", "decisions"],
        stat_values: ["3"],
      }),
    );
    expect(refusal).toContain("`stat_values` has 1 entry");
    expect(refusal).toContain("`stat_labels` has 2");
    expect(refusal).toContain("index-aligned");
    expect(w.board().document).toBeUndefined();
  });

  it("positive control: aligned arrays of the same length go through", () => {
    // Without this, every assertion above is satisfied by a writer that refuses all stats.
    const w = writer("design");
    ok(
      w.call("set_document", {
        title: "Design",
        intro_markdown: "Three requirements landed.",
        stat_labels: ["requirements", "decisions"],
        stat_values: ["3", "1"],
      }),
    );
    expect(w.board().document).toMatchObject({
      stats: [
        { label: "requirements", value: "3" },
        { label: "decisions", value: "1" },
      ],
    });
  });
});

describe("status stops claiming a settlement the board has moved past", () => {
  it("a call after finish reopens the board rather than being refused", () => {
    const w = writer("sequence");
    const span = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 11, end_line: 12 }),
    );
    const section = idOf(w.call("add_section", { title: "Start with refresh" }));
    idOf(
      w.call("add_step", { title: "Read the refresh path", span_ref_id: span, parent_id: section }),
    );
    expect(ok(w.call("finish")).outcome.kind).toBe("settled");
    expect(w.status()).toBe("settled");

    // Writing after a finish is ordinary work and is NOT refused…
    const more = w.call("add_prose", { markdown: "One more note.", parent_id: section });
    expect(more.ok).toBe(true);
    // …but the settlement was a statement about a board that has since changed.
    expect(w.status()).toBe("drafting");
    expect(ok(w.call("finish")).outcome.kind).toBe("settled");
    expect(w.status()).toBe("settled");
  });

  it("a call after settle_absent reopens it too, and drops the declared absence", () => {
    const w = writer("noise");
    ok(w.call("settle_absent", { note: "Every hunk carries meaning." }));
    expect(w.status()).toBe("absent");
    expect(w.declaredAbsence()?.reason).toBe("no-noise");

    ok(w.call("add_prose", { markdown: "On reflection, the lockfile churn is skip-safe." }));
    expect(w.status()).toBe("drafting");
    // The absence described a board with nothing on it; it does not survive an element.
    expect(w.declaredAbsence()).toBeUndefined();
  });
});

describe("set_document goes through the boundary, not just through lint", () => {
  // The document used to escape every prose rule. The production fix is the boundary
  // guard in `setDocument`, and these exercise THAT — the lint-level tests in
  // `lint.test.ts` pass with the guard deleted, so on their own they controlled nothing.

  it("a fenced code block in the intro is refused, naming the flat input field", () => {
    const w = writer();
    const refusal = refusalOf(
      w.call("set_document", {
        title: "Flagged",
        intro_markdown: "Like so:\n```ts\nconst x = 1;\n```\n",
      }),
    );
    expect(refusal).toContain("no-code-bytes");
    // The seat sent `intro_markdown`; `/document/introMarkdown` is not a field it has.
    expect(refusal).toContain("`intro_markdown`");
    expect(refusal).not.toContain("/document");
    // …and the board keeps no document at all.
    expect(w.board().document).toBeUndefined();
  });

  it("machinery vocabulary in the title is refused at the title", () => {
    const w = writer();
    const refusal = refusalOf(
      w.call("set_document", { title: "What the lens found", intro_markdown: "Two concerns." }),
    );
    expect(refusal).toContain("process-vocabulary");
    expect(refusal).toContain("`title`");
    expect(w.board().document).toBeUndefined();
  });

  it("an unresolvable citation in the intro is refused", () => {
    const w = writer();
    const refusal = refusalOf(
      w.call("set_document", { title: "Flagged", intro_markdown: "See `src/auth.ts:900`." }),
    );
    expect(refusal).toContain("citation-resolves");
    expect(refusal).toContain("`intro_markdown`");
  });

  it("positive control: a clean document is accepted and kept", () => {
    // Without this, all three refusals are satisfied by a writer that refuses every
    // document it is shown.
    const w = writer();
    ok(
      w.call("set_document", {
        title: "Flagged",
        intro_markdown: "Two concerns sit on the refresh path; `src/auth.ts:11` is the first.",
      }),
    );
    expect(w.board().document).toMatchObject({
      title: "Flagged",
      introMarkdown: "Two concerns sit on the refresh path; `src/auth.ts:11` is the first.",
    });
  });

  it("a document already on the board is not replaced by a refused call", () => {
    const w = writer();
    ok(w.call("set_document", { title: "Flagged", intro_markdown: "Two concerns." }));
    refusalOf(w.call("set_document", { title: "Flagged", intro_markdown: "```ts\nx\n```" }));
    expect(w.board().document).toMatchObject({ introMarkdown: "Two concerns." });
  });
});

describe("a refusal names the flat input even when the rule points into a nested field", () => {
  // `sourceLineKnown` and `sourceCandidateKnown` report at `<id>/source/line` and
  // `<id>/source/candidate`; the flat inputs are `source_line` and `source_candidate`.
  // Treating the whole suffix as one data field matched nothing and handed the seat
  // `source/line`, which is not a field it can change.
  const designWriter = () =>
    writer("design", {
      lint: {
        regions: REGIONS,
        files: new Map([["src/auth.ts", 200]]),
        artifacts: [{ path: "docs/spec.md", text: "One line only." }],
        artifactCandidates: [{ id: "cand-1", paths: ["docs/spec.md"] }],
      },
    });

  it("a source line past the end of the artifact names `source_line`", () => {
    const w = designWriter();
    const refusal = refusalOf(
      w.call("add_requirement", {
        shall: "The daemon SHALL resolve every citation against the captured patchset.",
        source_path: "docs/spec.md",
        source_candidate: "cand-1",
        source_line: 9,
      }),
    );
    expect(refusal).toContain("design-source-line-known");
    expect(refusal).toContain("`source_line`");
    expect(refusal).not.toContain("source/line");
    expect(w.board().elements).toHaveLength(0);
  });

  it("an unknown source candidate names `source_candidate`", () => {
    const w = designWriter();
    const refusal = refusalOf(
      w.call("add_requirement", {
        shall: "The daemon SHALL resolve every citation against the captured patchset.",
        source_path: "docs/spec.md",
        source_candidate: "not-a-candidate",
        source_line: 1,
      }),
    );
    expect(refusal).toContain("design-source-candidate-known");
    expect(refusal).toContain("`source_candidate`");
    expect(refusal).not.toContain("source/candidate");
  });

  it("positive control: a source that resolves goes through", () => {
    const w = designWriter();
    const id = idOf(
      w.call("add_requirement", {
        shall: "The daemon SHALL resolve every citation against the captured patchset.",
        source_path: "docs/spec.md",
        source_candidate: "cand-1",
        source_line: 1,
      }),
    );
    expect(dataOf<{ source: { line: number } }>(w, id).source.line).toBe(1);
  });
});

describe("the document is the seat's prose and the host's measure", () => {
  it("set_document keeps the title and prose and the host decides the measure", () => {
    const w = writer("design");
    ok(
      w.call("set_document", {
        title: "Design",
        intro_markdown: "Three requirements landed and one moved.",
      }),
    );
    expect(w.board().document).toEqual({
      title: "Design",
      introMarkdown: "Three requirements landed and one moved.",
      // `resolveBoardDocument` owns this, and `measure` is on no tool input.
      measure: "structured",
    });
  });
});
