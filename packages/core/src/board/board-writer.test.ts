import type { Author, DraftElement } from "@rennet/protocol";
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

const lintCtx = (over: Partial<LintContext> = {}): LintContext => ({
  lens: "flagged",
  regions: REGIONS,
  files: new Map([
    ["src/auth.ts", 200],
    ["src/util.ts", 50],
    ["pnpm-lock.yaml", 9000],
  ]),
  baseFiles: new Map([["src/legacy.ts", 120]]),
  ...over,
});

const writer = (target: LintTarget = "flagged", over: Partial<BoardWriterOptions> = {}) => {
  const { lint: lintOver, ...rest } = over;
  return new BoardWriter({
    target,
    author,
    lint: { ...lintCtx({ lens: target }), ...(lintOver ?? {}) },
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

  it("two writers on one board mint ids that cannot collide (D9, Flagged's two voices)", () => {
    const claude = writer("flagged", { idPrefix: "a" });
    const codex = writer("flagged", { idPrefix: "b" });
    const one = idOf(claude.call("add_section", { title: "Correctness" }));
    const two = idOf(codex.call("add_section", { title: "Correctness" }));
    expect(one).not.toBe(two);
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

    // Nothing on the board dangles, and no rule was run over it to find that out.
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

  it("a reference cycle is unconstructible: the one edge that runs forward is refused", () => {
    // `alternative_ids` is the one element reference with no declared target kind, so it
    // is the only way a decision could name an ancestor section and close a loop through
    // the host-maintained `children` edge. Attempt exactly that.
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
    // …and the board still carries the reference it had.
    expect(dataOf<{ alternatives: string[] }>(w, decision).alternatives).toEqual([ref]);
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
    // `src/auth.ts` changed on head only, so a base-side citation has nothing to hit.
    const refusal = refusalOf(
      w.call("cite", { path: "src/legacy.ts", side: "base", start_line: 100, end_line: 101 }),
    );
    expect(refusal).toContain("nearest changed range");
    const nothingChanged = refusalOf(
      w.call("cite", { path: "src/util.ts", side: "base", start_line: 1, end_line: 2 }),
    );
    expect(nothingChanged).toContain("no changed lines on the base side");
  });

  it("an inverted range is refused before anything else looks at it", () => {
    const w = writer();
    const refusal = refusalOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 14, end_line: 10 }),
    );
    expect(refusal).toContain("citation-resolves");
    expect(refusal).toContain("inverted");
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
        lens: "noise",
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

  it("a Sequence step no section reaches comes back as one pointer naming that step", () => {
    const w = writer("sequence");
    const span = idOf(
      w.call("cite", { path: "src/auth.ts", side: "head", start_line: 11, end_line: 12 }),
    );
    const section = idOf(w.call("add_section", { title: "Start with refresh" }));
    idOf(
      w.call("add_step", { title: "Read the refresh path", span_ref_id: span, parent_id: section }),
    );
    const orphan = idOf(w.call("add_step", { title: "Then the classifier", span_ref_id: span }));

    const pointers = pointersOf(w.call("finish"));
    const reach = pointers.filter((pointer) => pointer.ruleId === "sequence-step-reachable");
    expect(reach).toHaveLength(1);
    expect(reach[0]?.elementRef).toBe(orphan);
    expect(w.status()).toBe("drafting");

    // The seat answers the pointer with further calls in the same turn, and finishes.
    ok(w.call("remove_element", { element_id: orphan }));
    ok(w.call("add_step", { title: "Then the classifier", span_ref_id: span, parent_id: section }));
    const settled = ok(w.call("finish")).outcome;
    expect(settled.kind).toBe("settled");
    expect(w.status()).toBe("settled");
  });

  it("a pointer carries a rule, an element and one sentence — no prose, no draft", () => {
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
