import type { Author, BoardTool, DraftElement } from "@rennet/protocol";
import { boardToolsByName } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  type BoardToolResult,
  type BoardWrite,
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
    // NOT the D9 scenario: these are two writers each holding its OWN elements, so this
    // asserts the prefix alone. The shared-board case is the next test.
    const claude = writer("flagged", { idPrefix: "a" });
    const codex = writer("flagged", { idPrefix: "b" });
    const one = idOf(claude.call("add_section", { title: "Correctness" }));
    const two = idOf(codex.call("add_section", { title: "Correctness" }));
    expect(one).not.toBe(two);
    expect(one.startsWith("a")).toBe(true);
    expect(two.startsWith("b")).toBe(true);
  });

  it("two voices on ONE board are handed ids that cannot collide (D9)", () => {
    // The Flagged scenario: one writer, one element list, two voices. The daemon's board
    // server gives each of the lane's two addresses one of these handles.
    const board = writer("flagged");
    const claude = board.voice({
      author: { kind: "lens-agent", id: "lens:flagged:claudeAgent" },
      idPrefix: "f",
    });
    const codex = board.voice({
      author: { kind: "lens-agent", id: "lens:flagged:codex" },
      idPrefix: "g",
    });
    const one = idOf(claude.call("add_section", { title: "Correctness" }));
    const two = idOf(codex.call("add_section", { title: "Risk" }));

    expect(one).not.toBe(two);
    expect(one.startsWith("f")).toBe(true);
    expect(two.startsWith("g")).toBe(true);
    // ONE board holding both, in call order — which two separate writers cannot produce.
    expect(board.board().elements.map((element) => element.id)).toEqual([one, two]);
    expect(claude.board().elements).toHaveLength(2);
    // Each element carries the voice that wrote it, not the writer's own author.
    expect(dataOf<{ author: Author }>(board, one).author.id).toBe("lens:flagged:claudeAgent");
    expect(dataOf<{ author: Author }>(board, two).author.id).toBe("lens:flagged:codex");
  });

  it("one voice can reference an element the other voice created, because it is one board", () => {
    const board = writer("flagged");
    const claude = board.voice({
      author: { kind: "lens-agent", id: "lens:flagged:claudeAgent" },
      idPrefix: "f",
    });
    const codex = board.voice({
      author: { kind: "lens-agent", id: "lens:flagged:codex" },
      idPrefix: "g",
    });
    const cited = idOf(
      claude.call("cite", { path: "src/auth.ts", side: "head", start_line: 11, end_line: 12 }),
    );
    const finding = idOf(
      codex.call("add_finding", {
        severity: "medium",
        concern: "The classification happens before the code is read.",
        code_ref_ids: [cited],
      }),
    );
    expect(dataOf<{ code: string[] }>(board, finding).code).toEqual([cited]);
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
        alternatives: ["Classify first and re-read the code."],
      }),
    );

    // (a) referencing an id that was never minted
    expect(
      refusalOf(
        w.call("add_decision", {
          statement: "A second call.",
          why: "Because.",
          evidence_ref_ids: ["never-minted"],
          alternatives: ["Do it the other way."],
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
    // asks only whether the board holds the id — so `evidence_ref_ids`, `scenario_ids`,
    // `trace_ref_ids`, `code_ref_id` and `code_ref_ids` can each name an ancestor
    // section and close a loop through the host-maintained `children` edge, which is the
    // one edge that runs forward. This is the UPDATE path; the add path is the test
    // below.
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
        alternatives: ["Move the lifetime into a shared cache."],
        parent_id: section,
      }),
    );
    // section --children--> decision --evidence--> section  is a cycle.
    const refusal = refusalOf(
      w.call("update_decision", { element_id: decision, evidence_ref_ids: [section] }),
    );
    expect(refusal).toContain("cycle");
    // Name what refuses it: the boundary tier's `element-reference-resolves`, which is
    // the mechanism D5 assigns and the one the control below removes.
    expect(refusal).toContain("element-reference-resolves");
    // …and the board still carries the reference it had.
    expect(dataOf<{ evidence: string[] }>(w, decision).evidence).toEqual([ref]);
  });

  it("a reference cycle is unconstructible on the ADD path too, through a single ref", () => {
    // The same loop, closed by the call that CREATES the element rather than by a later
    // update, and through a SINGLE-valued reference field rather than a list — so the
    // guard is not something only `update_*`, and not something only a list field,
    // happens to run.
    const w = writer("decisions");
    const section = idOf(w.call("add_section", { title: "Storage" }));
    const refusal = refusalOf(
      // section --children--> (this annotation) --code_ref--> section
      w.call("add_annotation", {
        body: "Storage stays on the caller.",
        code_ref_id: section,
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
        alternatives: ["Move the lifetime into a shared cache."],
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
        alternatives: [],
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
        alternatives: ["Move the lifetime into a shared cache."],
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
    // Decisions, not Noise: `no-noise` became the HOST's settlement at D16e — it knows
    // the derived membership is empty before the seat's first turn — so the Noise seat
    // has no settle-absent verb to make this call with.
    const w = writer("decisions");
    const outcome = ok(w.call("settle_absent", { note: "Nothing was decided here." })).outcome;
    expect(outcome).toEqual({
      kind: "absent",
      reason: "no-decisions",
      note: "Nothing was decided here.",
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
    // Through `set_document`, which is the ONLY reach this guard has: `stats` is the one
    // list group on any tool with two parts, so the calls in `add` and `update` cannot
    // fire and deleting either reddens nothing. Recorded on `checkListAlignment` and in
    // the PR ledger rather than implied to be covered.
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
    const w = writer("decisions");
    ok(w.call("settle_absent", { note: "Nothing was decided here." }));
    expect(w.status()).toBe("absent");
    expect(w.declaredAbsence()?.reason).toBe("no-decisions");

    ok(w.call("add_prose", { markdown: "On reflection, the retry cap was a call." }));
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

/**
 * D16 — the Noise board's members are the host's derivation, so the seat is handed them.
 *
 * Every claim here is proven by ATTEMPTING the thing through the surface: the tool a seat
 * would use to add a member does not exist and the call is refused by name, and a removal
 * is refused with its reason — never asserted about a board the test built by hand.
 */
describe("a host-derived board's members belong to the host (D16)", () => {
  const noiseWriter = () => writer("noise");

  it("places one citation and one member per uncited region, stamped with the constants", () => {
    const w = noiseWriter();
    const placed = w.placeMembers("noise_verdict", [
      { path: "src/util.ts", side: "head", start: 1, end: 3 },
    ]);
    const [memberId] = placed;
    if (memberId === undefined) throw new Error("the host placed no member");

    const citationId = w.board().elements.find((el) => el.kind === "code_ref")?.id;
    if (citationId === undefined) throw new Error("the host placed no citation");

    expect(heldElement(w, memberId).kind).toBe("noise_verdict");
    const member = dataOf<Record<string, unknown>>(w, memberId);
    // Both host-stamped constants (D16f), and both absent from every tool input.
    expect(member.verdict).toBe("noise");
    expect(member.judge).toBe("deterministic");
    // The member points at the citation the host placed beside it.
    expect(member.hunk).toBe(citationId);
    expect(dataOf<Record<string, unknown>>(w, citationId).path).toBe("src/util.ts");
    expect(w.hostPlacedIds()).toEqual([citationId, memberId]);
  });

  it("there is no verb that creates a member, so a seat cannot add one", () => {
    const w = noiseWriter();
    expect(w.toolNames()).not.toContain("add_noise_verdict");
    // Attempted, not asserted about: this is the call a seat would actually make.
    expect(
      refusalOf(w.call("add_noise_verdict", { hunk_ref_id: "e1", reason: "lockfile" })),
    ).toContain("There is no `add_noise_verdict` on this board");
  });

  it("remove_element refuses a host-placed member and still removes the seat's own section", () => {
    const w = noiseWriter();
    const [member] = w.placeMembers("noise_verdict", [
      { path: "src/util.ts", side: "head", start: 1, end: 3 },
    ]);
    if (member === undefined) throw new Error("the host placed no member");

    const refusal = refusalOf(w.call("remove_element", { element_id: member }));
    expect(refusal).toContain(member);
    expect(refusal).toContain("no other board cited");
    expect(w.board().elements.some((el) => el.id === member)).toBe(true);

    // The seat's OWN elements still go: the refusal is about derived membership, not
    // about removal.
    const group = idOf(w.call("add_section", { title: "Lockfile Regeneration" }));
    ok(w.call("remove_element", { element_id: group }));
    expect(w.board().elements.some((el) => el.id === group)).toBe(false);
  });

  it("removing a group the members hang under is refused too, not just the member itself", () => {
    // The sideways door: `remove_element` takes the whole subtree, so removing the group
    // would take its members off the board without the call ever naming one.
    const w = noiseWriter();
    const [member] = w.placeMembers("noise_verdict", [
      { path: "src/util.ts", side: "head", start: 1, end: 3 },
    ]);
    if (member === undefined) throw new Error("the host placed no member");
    const group = idOf(w.call("add_section", { title: "Lockfile Regeneration" }));
    ok(w.call("update_noise_verdict", { element_id: member, parent_id: group }));

    expect(refusalOf(w.call("remove_element", { element_id: group }))).toContain(member);
    expect(w.board().elements.some((el) => el.id === member)).toBe(true);
  });

  it("update_noise_verdict is how the seat groups a member and says why", () => {
    const w = noiseWriter();
    const [member] = w.placeMembers("noise_verdict", [
      { path: "src/util.ts", side: "head", start: 1, end: 3 },
    ]);
    if (member === undefined) throw new Error("the host placed no member");
    const group = idOf(w.call("add_section", { title: "Formatter-Only Churn" }));

    ok(
      w.call("update_noise_verdict", {
        element_id: member,
        parent_id: group,
        reason: "Reflowed by the formatter when the import block above it moved.",
      }),
    );
    expect(dataOf<{ children: string[] }>(w, group).children).toContain(member);
    const updated = dataOf<Record<string, unknown>>(w, member);
    expect(updated.reason).toContain("formatter");
    // The constants survive the update; there is no field on the input to change them.
    expect(updated.verdict).toBe("noise");
    expect(updated.judge).toBe("deterministic");
  });

  it("finish points at an ungrouped member and at a group with no reason", () => {
    const w = noiseWriter();
    const placed = w.placeMembers("noise_verdict", [
      { path: "src/util.ts", side: "head", start: 1, end: 3 },
      { path: "src/auth.ts", side: "head", start: 10, end: 14 },
    ]);
    const [first, second] = placed;
    if (first === undefined || second === undefined) throw new Error("two members expected");

    const group = idOf(w.call("add_section", { title: "Formatter-Only Churn" }));
    ok(w.call("update_noise_verdict", { element_id: first, parent_id: group }));

    // One grouped without a reason, one not grouped at all — both come back as pointers.
    const verdict = pointersOf(w.call("finish"));
    expect(verdict.map((p) => p.ruleId)).toContain("derived-member-grouped");
    expect(verdict.map((p) => p.ruleId)).toContain("derived-group-reasoned");
    expect(verdict.some((p) => p.elementRef.includes(second))).toBe(true);

    // The seat answers both in the same turn, and the next finish settles.
    ok(w.call("update_noise_verdict", { element_id: second, parent_id: group }));
    ok(
      w.call("add_prose", {
        parent_id: group,
        markdown: "Reflowed by the formatter when the import block above them moved.",
      }),
    );
    expect(ok(w.call("finish")).outcome.kind).toBe("settled");
    expect(w.status()).toBe("settled");
  });

  it("regrouping a member MOVES it, so it can never be in two groups at once", () => {
    // The "exactly one group" half of the rule is therefore unconstructible through the
    // surface, and it is the zero-group arm the rule actually fires on. Named here rather
    // than left implied: the two-group message exists and no seat can reach it.
    const w = noiseWriter();
    const [member] = w.placeMembers("noise_verdict", [
      { path: "src/util.ts", side: "head", start: 1, end: 3 },
    ]);
    if (member === undefined) throw new Error("the host placed no member");
    const first = idOf(w.call("add_section", { title: "Formatter-Only Churn" }));
    const second = idOf(w.call("add_section", { title: "Lockfile Regeneration" }));
    ok(w.call("update_noise_verdict", { element_id: member, parent_id: first }));
    ok(w.call("update_noise_verdict", { element_id: member, parent_id: second }));

    expect(dataOf<{ children: string[] }>(w, first).children).not.toContain(member);
    expect(dataOf<{ children: string[] }>(w, second).children).toEqual([member]);
    // …and the same parent twice does not count it twice either.
    ok(w.call("update_noise_verdict", { element_id: member, parent_id: second }));
    expect(dataOf<{ children: string[] }>(w, second).children).toEqual([member]);
  });

  it("a group that does not exist is refused, so a member is never parked on nothing", () => {
    const w = noiseWriter();
    const [member] = w.placeMembers("noise_verdict", [
      { path: "src/util.ts", side: "head", start: 1, end: 3 },
    ]);
    if (member === undefined) throw new Error("the host placed no member");
    expect(
      refusalOf(w.call("update_noise_verdict", { element_id: member, parent_id: "nope" })),
    ).toContain("This board holds no `nope`");
  });
});

/** D6 — the last `finish` verdict is the whole content of a repair turn. */
describe("the writer remembers what finish said", () => {
  it("nothing before the first finish, the pointers after a failed one, [] after a clean one", () => {
    const w = writer("sequence");
    // Never asked is a different fact from settled: a turn that died before calling
    // `finish` has no verdict to carry, and its repair turn has to say so.
    expect(w.lastVerdict()).toBeUndefined();

    const span = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 10, end_line: 14 }),
    );
    const orphan = idOf(w.call("add_step", { title: "Read the entry point", span_ref_id: span }));
    const failed = pointersOf(w.call("finish"));
    expect(failed.length).toBeGreaterThan(0);
    expect(w.lastVerdict()).toEqual(failed);
    expect(failed.some((p) => p.elementRef.includes(orphan))).toBe(true);

    // Answer the pointer in the same turn: give the step a parent it can be reached from.
    const section = idOf(w.call("add_section", { title: "Reading Order" }));
    ok(w.call("remove_element", { element_id: orphan }));
    const span2 = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 10, end_line: 14 }),
    );
    idOf(
      w.call("add_step", {
        parent_id: section,
        title: "Read the entry point",
        span_ref_id: span2,
      }),
    );
    expect(ok(w.call("finish")).outcome.kind).toBe("settled");
    expect(w.lastVerdict()).toEqual([]);
  });

  it("a voice reads the same verdict as the writer, because there is one board", () => {
    const w = writer("flagged");
    const voice = w.voice({ author: { kind: "lens-agent", id: "flagged-codex" }, idPrefix: "b" });
    expect(voice.lastVerdict()).toBeUndefined();
    voice.call("finish");
    expect(voice.lastVerdict()).toEqual(w.lastVerdict());
    expect(voice.lastVerdict()?.length).toBeGreaterThan(0);
  });
});

/**
 * D9 — Flagged is two seats, two voices, ONE board. The lane needs each voice's own
 * settlement, because one seat finishing is not the lane finishing.
 */
describe("two voices on one board keep their own settlements (D9)", () => {
  const twoVoices = () => {
    const w = writer("flagged");
    const claude = w.voice({ author: { kind: "lens-agent", id: "flagged-claude" }, idPrefix: "a" });
    const codex = w.voice({ author: { kind: "lens-agent", id: "flagged-codex" }, idPrefix: "b" });
    return { w, claude, codex };
  };

  /** A finding, cited, under a section — the smallest board `finish` will settle. */
  const writeFinding = (voice: ReturnType<BoardWriter["voice"]>, concern: string): string => {
    const section = idOf(voice.call("add_section", { title: "Findings" }));
    const cite = idOf(
      voice.call("cite", { path: "src/auth.ts", side: "head", start_line: 10, end_line: 14 }),
    );
    return idOf(
      voice.call("add_finding", {
        parent_id: section,
        severity: "high",
        concern,
        code_ref_ids: [cite],
      }),
    );
  };

  it("each element carries the voice that wrote it, and the ids cannot collide", () => {
    const { w, claude, codex } = twoVoices();
    const a = writeFinding(claude, "The retry cap is unbounded.");
    const b = writeFinding(codex, "The retry cap is unbounded.");

    expect(a).not.toBe(b);
    expect(a.startsWith("a")).toBe(true);
    expect(b.startsWith("b")).toBe(true);
    // One board, two authors — the stamp is what the reconciliation partitions on.
    expect(dataOf<{ author: Author }>(w, a).author.id).toBe("flagged-claude");
    expect(dataOf<{ author: Author }>(w, b).author.id).toBe("flagged-codex");
    expect(w.board().elements.filter((el) => el.kind === "finding")).toHaveLength(2);
  });

  it("one voice finishing does not settle the other, and does not settle the lane", () => {
    const { claude, codex } = twoVoices();
    writeFinding(claude, "The retry cap is unbounded.");
    writeFinding(codex, "The retry cap is unbounded.");

    expect(ok(claude.call("finish")).outcome.kind).toBe("settled");
    expect(claude.voiceStatus()).toBe("settled");
    // The other voice has said nothing about being finished, and the lane is not settled
    // until it does. Reading the BOARD's state per seat is what would get this wrong.
    expect(codex.voiceStatus()).toBe("drafting");

    expect(ok(codex.call("finish")).outcome.kind).toBe("settled");
    expect(codex.voiceStatus()).toBe("settled");
    expect(claude.voiceStatus()).toBe("settled");
  });

  it("one voice writing again does not un-finish the other", () => {
    const { claude, codex } = twoVoices();
    writeFinding(claude, "The retry cap is unbounded.");
    ok(claude.call("finish"));
    expect(claude.voiceStatus()).toBe("settled");

    writeFinding(codex, "The lockfile was hand-edited.");
    // The board moved, so the BOARD is drafting again — but Claude's seat said what it
    // had to say and its lane state must survive its partner's next element.
    expect(claude.voiceStatus()).toBe("settled");
    expect(codex.voiceStatus()).toBe("drafting");
  });

  it("a voice's own next element does un-finish that voice", () => {
    const { claude } = twoVoices();
    writeFinding(claude, "The retry cap is unbounded.");
    ok(claude.call("finish"));
    ok(claude.call("add_prose", { markdown: "One more thing about the cap." }));
    expect(claude.voiceStatus()).toBe("drafting");
  });
});

/**
 * D6 — a refusal and a `finish` verdict are answered INSIDE the turn that caused them,
 * so neither is a settlement and neither is an un-settlement. The lane's attempt
 * accounting reads `voiceStatus()` once per turn, so what this proves is the fact that
 * accounting rests on.
 */
describe("a refusal costs nothing and a verdict costs nothing (D6)", () => {
  it("ten refusals and one verdict leave the seat exactly where it was: still drafting", () => {
    const w = writer("sequence");
    // The writer's OWN author: every call below is `w.call`, so the voice being read is
    // the default one. Reading a different voice's record here would assert nothing.
    const voiceStatus = () => w.voiceStatus(undefined);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      // Outside the change on a path the patchset does not hold — refused at the boundary.
      const refusal = w.call("cite", {
        path: "src/never-changed.ts",
        side: "head",
        start_line: attempt + 1,
        end_line: attempt + 2,
      });
      expect(refusal.ok).toBe(false);
    }
    // A verdict with work in it. Not a settlement — and, crucially, not a state the lane
    // could mistake for one.
    const span = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 10, end_line: 14 }),
    );
    const orphan = idOf(w.call("add_step", { title: "Read the entry point", span_ref_id: span }));
    expect(pointersOf(w.call("finish")).length).toBeGreaterThan(0);
    expect(voiceStatus()).toBe("drafting");

    // The seat answers the verdict in the SAME turn and finishes. One turn, one attempt.
    ok(w.call("remove_element", { element_id: orphan }));
    const section = idOf(w.call("add_section", { title: "Reading Order" }));
    const span2 = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 10, end_line: 14 }),
    );
    idOf(
      w.call("add_step", { parent_id: section, title: "Read the entry point", span_ref_id: span2 }),
    );
    expect(ok(w.call("finish")).outcome.kind).toBe("settled");
    expect(voiceStatus()).toBe("settled");
  });
});

// ── The element stream and the call count (`lens-board-tools` D11, tasks 4.1/4.3) ──

describe("BoardWriter publication", () => {
  /** A writer with its observer's writes recorded in order. */
  const observed = (target: LintTarget = "sequence") => {
    const writes: BoardWrite[] = [];
    const w = writer(target, { onWrite: (write) => writes.push(write) });
    return { w, writes };
  };

  it("publishes the elements one call touched, at their positions, and nothing else", () => {
    const { w, writes } = observed();
    const section = idOf(w.call("add_section", { title: "Reading Order" }));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.changed.map(({ index, element }) => [index, element.id])).toEqual([
      [0, section],
    ]);
    expect(writes[0]?.removed).toEqual([]);
    expect(writes[0]?.state).toBe("drafting");

    // A parented add touches TWO elements — the child and the parent whose `children`
    // grew — and the stream carries both, because a reader folding only the child would
    // hold a parent that does not name it.
    const span = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 10, end_line: 14 }),
    );
    const step = idOf(
      w.call("add_step", { parent_id: section, title: "Read the entry point", span_ref_id: span }),
    );
    const last = writes.at(-1);
    expect(last?.changed.map(({ element }) => element.id).sort()).toEqual([section, step].sort());
    // The child lands at its own index; the parent is re-published at the index it already
    // occupies, so folding it is a replace and not a second copy.
    expect(last?.changed.find(({ element }) => element.id === step)?.index).toBe(2);
    expect(last?.changed.find(({ element }) => element.id === section)?.index).toBe(0);
  });

  it("publishes nothing for a refused call, and the board did not move either", () => {
    const { w, writes } = observed();
    const before = writes.length;
    const refusal = w.call("cite", {
      path: "src/never-changed.ts",
      side: "head",
      start_line: 1,
      end_line: 2,
    });
    expect(refusal.ok).toBe(false);
    expect(writes).toHaveLength(before);
    expect(w.board().elements).toHaveLength(0);
  });

  it("publishes a removal by id, with the whole subtree it took", () => {
    const { w, writes } = observed();
    const section = idOf(w.call("add_section", { title: "Reading Order" }));
    const prose = idOf(w.call("add_prose", { parent_id: section, markdown: "why" }));
    ok(w.call("remove_element", { element_id: section }));
    const last = writes.at(-1);
    expect([...(last?.removed ?? [])].sort()).toEqual([prose, section].sort());
    expect(last?.changed).toEqual([]);
  });

  it("carries the board's state on every write, so `finish` publishes the settlement", () => {
    const { w, writes } = observed();
    const section = idOf(w.call("add_section", { title: "Reading Order" }));
    const span = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 10, end_line: 14 }),
    );
    idOf(
      w.call("add_step", { parent_id: section, title: "Read the entry point", span_ref_id: span }),
    );
    expect(writes.at(-1)?.state).toBe("drafting");
    expect(ok(w.call("finish")).outcome.kind).toBe("settled");
    expect(writes.at(-1)?.state).toBe("settled");
    expect(writes.at(-1)?.changed).toEqual([]);
  });

  it("publishes the members the HOST places, before any seat call", () => {
    // A derived board's members land before the Noise seat's first turn (D16). A stream
    // that only carried the seat's own calls would show a derived board appear out of
    // nowhere at settle.
    const { w, writes } = observed("noise");
    const placed = w.placeMembers("noise_verdict", [
      { path: "src/util.ts", side: "head", start: 1, end: 3 },
    ]);
    expect(placed).toHaveLength(1);
    expect(writes).toHaveLength(1);
    // One `code_ref` and one member, both host-minted, both published.
    expect(writes[0]?.changed.map(({ element }) => element.kind)).toEqual([
      "code_ref",
      "noise_verdict",
    ]);
    expect(writes[0]?.changed.map(({ index }) => index)).toEqual([0, 1]);
  });

  it("counts every call this voice made, refusals and unknown tools included", () => {
    const w = writer("sequence");
    const voice = w.voice({ author });
    expect(voice.callCount()).toBe(0);
    idOf(voice.call("add_section", { title: "Reading Order" }));
    expect(voice.callCount()).toBe(1);
    // A refused call is a call the seat made and the provider billed. A count that only
    // saw the accepted ones would report a seat fighting the boundary as the cheaper one.
    expect(
      voice.call("cite", { path: "src/nope.ts", side: "head", start_line: 1, end_line: 2 }).ok,
    ).toBe(false);
    expect(voice.call("no_such_verb", {}).ok).toBe(false);
    expect(voice.callCount()).toBe(3);
  });

  it("counts each voice separately, because Flagged is two seats over one board", () => {
    const w = writer("flagged");
    const claude = w.voice({ author: { kind: "lens-agent", id: "seat:flagged-claude" } });
    const codex = w.voice({ author: { kind: "lens-agent", id: "seat:flagged-codex" } });
    idOf(claude.call("add_section", { title: "Findings" }));
    idOf(claude.call("add_prose", { markdown: "one" }));
    idOf(codex.call("add_prose", { markdown: "two" }));
    expect(claude.callCount()).toBe(2);
    expect(codex.callCount()).toBe(1);
  });
});

/**
 * `write_board` — the whole board in one call (#869's spike).
 *
 * The property under test is NOT "a board can be built": every other block here proves
 * that. It is that the same board costs the seat ONE call instead of N, because a call is
 * a provider round trip and round trips are what #867 measured. So every case below reads
 * `callCount`, and the refusal cases prove the batch answers per entry rather than
 * opaquely — an opaque refusal would send the seat round again and put the round trips
 * straight back.
 */
describe("write_board writes the whole board in one call", () => {
  const payload = (calls: readonly Record<string, unknown>[]) => ({
    board_json: JSON.stringify({ calls }),
  });

  const SEQUENCE_BOARD: Record<string, unknown>[] = [
    {
      tool: "cite",
      local_id: "c1",
      path: "src/auth.ts",
      side: "head",
      start_line: 11,
      end_line: 12,
    },
    { tool: "add_section", local_id: "s1", title: "Start with refresh" },
    { tool: "add_step", parent_id: "s1", title: "Read the refresh path", span_ref_id: "c1" },
  ];

  it("settles the board, and the seat paid one round trip for it", () => {
    const w = writer("sequence");
    const outcome = ok(w.call("write_board", payload(SEQUENCE_BOARD))).outcome;
    if (outcome.kind !== "wrote") throw new Error(`expected a write, got ${outcome.kind}`);
    expect(outcome.accepted).toBe(3);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.settled).toBe(true);
    expect(w.status()).toBe("settled");
    // The whole point. The same board written one verb at a time is four calls (three plus
    // `finish`); this is one, and the count is the figure the daemon logs as `tools=` and
    // #867 measured per seat.
    expect(w.callCount(undefined)).toBe(1);
    expect(w.board().elements).toHaveLength(3);
  });

  it("resolves a payload's own names to the ids the host minted", () => {
    // A payload cannot name an id that does not exist yet, so `local_id` is the only way a
    // child can name its parent inside one call. Asserted on the BOARD rather than on the
    // outcome: the step's parenting and its span reference must both point at real
    // host-minted ids, which is what the boundary tier would otherwise have refused.
    const w = writer("sequence");
    ok(w.call("write_board", payload(SEQUENCE_BOARD)));
    const elements = w.board().elements;
    const find = (kind: string): DraftElement => {
      const found = elements.find((element) => element.kind === kind);
      if (found === undefined) throw new Error(`the board holds no \`${kind}\``);
      return found;
    };
    const cite = find("code_ref");
    const section = find("section");
    const step = find("order_step");
    // The local names are gone: nothing on the board says `c1` or `s1`.
    expect(JSON.stringify(elements)).not.toContain('"c1"');
    expect(JSON.stringify(elements)).not.toContain('"s1"');
    expect((step.data as { span?: string }).span).toBe(cite.id);
    expect((section.data as { children?: string[] }).children).toEqual([step.id]);
  });

  it("names the entry it refused by position, and keeps everything else on the board", () => {
    // The measurement depends on this. A batch that refused opaquely would make the seat
    // resend all of it to find out which entry was wrong — the round trips this verb exists
    // to remove, reintroduced at the worst possible moment.
    const w = writer("sequence");
    const outcome = ok(
      w.call(
        "write_board",
        payload([
          { tool: "add_section", local_id: "s1", title: "Start with refresh" },
          // Outside every changed region: the boundary tier refuses this one entry.
          {
            tool: "cite",
            local_id: "c1",
            path: "src/auth.ts",
            side: "head",
            start_line: 900,
            end_line: 901,
          },
          { tool: "add_prose", parent_id: "s1", markdown: "The refresh path is read first." },
        ]),
      ),
    ).outcome;
    if (outcome.kind !== "wrote") throw new Error(`expected a write, got ${outcome.kind}`);
    expect(outcome.accepted).toBe(2);
    expect(outcome.refusals).toHaveLength(1);
    expect(outcome.refusals[0]?.index).toBe(1);
    expect(outcome.refusals[0]?.tool).toBe("cite");
    expect(outcome.refusals[0]?.refusal).toContain("src/auth.ts");
    // The two that landed are on the board, so the seat redoes one entry and not three.
    expect(w.board().elements).toHaveLength(2);
    // And no `finish` ran over a board known to be missing an element: pointers about the
    // absent citation would have buried the refusal that caused them.
    expect(outcome.settled).toBe(false);
    expect(outcome.pointers).toBeUndefined();
    expect(w.status()).toBe("drafting");
  });

  it("hands back finish pointers when every entry lands but the board does not settle", () => {
    const w = writer("sequence");
    const outcome = ok(
      w.call(
        "write_board",
        payload([
          {
            tool: "cite",
            local_id: "c1",
            path: "src/auth.ts",
            side: "head",
            start_line: 11,
            end_line: 12,
          },
          // A step with no section over it: taken by the boundary tier, refused by the
          // finish tier's reachability rule.
          { tool: "add_step", title: "Read the refresh path", span_ref_id: "c1" },
        ]),
      ),
    ).outcome;
    if (outcome.kind !== "wrote") throw new Error(`expected a write, got ${outcome.kind}`);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.settled).toBe(false);
    expect(outcome.pointers?.[0]?.ruleId).toBe("sequence-step-reachable");
    expect(w.status()).toBe("drafting");
    expect(w.callCount(undefined)).toBe(1);
  });

  it("refuses a payload that is not JSON, and writes nothing", () => {
    const w = writer("sequence");
    expect(refusalOf(w.call("write_board", { board_json: "{not json" }))).toContain("not JSON");
    expect(w.board().elements).toEqual([]);
  });

  it("refuses a payload with no `calls` array, and writes nothing", () => {
    const w = writer("sequence");
    const result = w.call("write_board", { board_json: JSON.stringify({ elements: [] }) });
    expect(refusalOf(result)).toContain("no `calls` array");
    expect(w.board().elements).toEqual([]);
  });

  it("refuses an entry naming a verb this lens does not have, without stopping the batch", () => {
    // A Sequence seat has no `add_finding`. The entry is refused by name and the entries
    // around it still land — the same per-entry answer a bad field gets.
    const w = writer("sequence");
    const outcome = ok(
      w.call(
        "write_board",
        payload([
          { tool: "add_section", local_id: "s1", title: "Start with refresh" },
          { tool: "add_finding", title: "Not this lens's verb", severity: "low" },
        ]),
      ),
    ).outcome;
    if (outcome.kind !== "wrote") throw new Error(`expected a write, got ${outcome.kind}`);
    expect(outcome.refusals[0]?.index).toBe(1);
    expect(outcome.refusals[0]?.refusal).toContain("There is no `add_finding` on this board");
    expect(w.board().elements).toHaveLength(1);
  });

  it("does not nest", () => {
    const w = writer("sequence");
    const outcome = ok(
      w.call("write_board", payload([{ tool: "write_board", board_json: "{}" }])),
    ).outcome;
    if (outcome.kind !== "wrote") throw new Error(`expected a write, got ${outcome.kind}`);
    expect(outcome.refusals[0]?.refusal).toContain("does not nest");
  });

  it("publishes each element as it lands, not one frame for the whole batch", () => {
    // The reader watches the board fill (D11). A whole-board write must not turn that into
    // one frame that appears complete out of nowhere.
    const writes: BoardWrite[] = [];
    const w = writer("sequence", { onWrite: (write) => writes.push(write) });
    ok(w.call("write_board", payload(SEQUENCE_BOARD)));
    expect(writes.length).toBeGreaterThanOrEqual(4);
    expect(writes[0]?.changed).toHaveLength(1);
    expect(writes.at(-1)?.state).toBe("settled");
  });
});
