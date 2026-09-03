import type { DraftBoard, DraftElement } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { ChangedRegion, LintContext } from "./lint";
import {
  checkImmutability,
  LADDER_RUNGS,
  RETRY_CAP,
  type RetryRequest,
  type ValidateSeams,
  validateDraft,
} from "./validate";

// ── Fixtures (schema-valid drafts; no casts to reach a branch) ────────────────

const author = { kind: "lens-agent" as const, id: "flagged-seat" };

const el = (id: string, kind: string, data: Record<string, unknown>): DraftElement =>
  ({ id, kind, data: { author, ...data } }) as DraftElement;

const codeRef = (id: string, path: string, start: number, end: number): DraftElement =>
  el(id, "code_ref", { patchset_id: "ps-1", path, side: "head", start_line: start, end_line: end });

const finding = (id: string, concern: string, code: string[] = []): DraftElement =>
  el(id, "finding", { severity: "high", concern, code, concurrence: [], status: "open" });

const board = (elements: DraftElement[], extra: Record<string, unknown> = {}): DraftBoard =>
  ({ elements, ...extra }) as DraftBoard;

const REGIONS: ChangedRegion[] = [
  { path: "src/auth.ts", side: "head", start: 10, end: 14 },
  { path: "src/util.ts", side: "head", start: 1, end: 3 },
];

const ctx = (over: Partial<LintContext> = {}): LintContext => ({
  lens: "flagged",
  regions: REGIONS,
  files: new Map([
    ["src/auth.ts", 200],
    ["src/util.ts", 50],
  ]),
  ...over,
});

/** A board lint passes clean: a grounded finding + its citation inside the change. */
const cleanBoard = (): DraftBoard =>
  board([
    finding("f1", "The refresh token is classified as an error before its code is read.", ["c1"]),
    codeRef("c1", "src/auth.ts", 11, 12),
  ]);

/** A seat that must never be asked (a clean board takes no retries). */
const noRetry: ValidateSeams["runTurn"] = () => {
  throw new Error("runTurn must not be called");
};

const findEl = (b: DraftBoard, id: string): DraftElement | undefined =>
  b.elements.find((e) => e.id === id);

// ── A clean draft passes straight through ─────────────────────────────────────

describe("validateDraft — the clean path", () => {
  it("a clean draft ships unchanged, no retries, no blemishes, no omissions", async () => {
    const result = await validateDraft(cleanBoard(), ctx(), { runTurn: noRetry });
    expect(result.attempts).toBe(0);
    expect(result.blemishes).toEqual([]);
    expect(result.omissions).toEqual([]);
    expect(result.immutability).toEqual([]);
    expect(result.board.elements.map((e) => e.id)).toEqual(["f1", "c1"]);
  });
});

// ── Retry + freeze: the patched element re-lints; frozen elements are untouched ─

describe("validateDraft — retry channel + freeze", () => {
  it("returns pointers, re-lints the patched element, and never re-drafts a frozen one", async () => {
    // f1 + c1 lint clean (freeze); p1 carries code bytes (no-code-bytes fires).
    const dirty = board([
      finding("f1", "The refresh token is classified before its code is read.", ["c1"]),
      codeRef("c1", "src/auth.ts", 11, 12),
      el("p1", "prose", { markdown: "```ts\nconst x = 1;\n```" }),
    ]);

    let seen: RetryRequest | undefined;
    const seat: ValidateSeams["runTurn"] = (req) => {
      seen = req;
      // The seat fixes p1 AND tries to mutate the frozen f1 — the mutation must be ignored.
      return board([
        finding("f1", "MUTATED — the seat should not be allowed to change this frozen finding.", [
          "c1",
        ]),
        codeRef("c1", "src/auth.ts", 11, 12),
        el("p1", "prose", { markdown: "The token is read before classification." }),
      ]);
    };

    const result = await validateDraft(dirty, ctx(), { runTurn: seat });

    // The channel carried a ZodError-shaped pointer at the offending prose field.
    expect(seen).toBeDefined();
    expect(seen?.pointers?.[0]?.ruleId).toBe("no-code-bytes");
    expect(seen?.pointers?.[0]?.path).toEqual(["elements", 2, "data", "markdown"]);
    expect(seen?.pointers?.[0]?.rung).toBe(1);
    // …and the ids the host will keep verbatim whatever comes back (#737): the passing
    // finding and its code ref froze; the offending prose did not.
    expect(seen?.frozenIds).toEqual(["f1", "c1"]);

    // The frozen finding is byte-identical to the original — not the seat's mutation.
    expect((findEl(result.board, "f1")?.data as { concern: string } | undefined)?.concern).toBe(
      "The refresh token is classified before its code is read.",
    );
    // The dirty prose was patched and now re-lints clean.
    expect((findEl(result.board, "p1")?.data as { markdown: string } | undefined)?.markdown).toBe(
      "The token is read before classification.",
    );
    expect(result.attempts).toBe(1);
    expect(result.blemishes).toEqual([]);
  });
});

// ── One repair turn ends in an honest omission ───────────────────────────────

describe("validateDraft — the escalation ladder", () => {
  it("asks once, then omits an unfixable element with its reason", async () => {
    // f1's concern cites a line past the file (citation-resolves) and the seat
    // stubbornly returns the same broken board every turn.
    const unfixable = board([
      finding("f1", "See the overrun at src/auth.ts:9999 — this never resolves.", ["c1"]),
      codeRef("c1", "src/auth.ts", 11, 12),
    ]);

    const rungs: number[] = [];
    const seat: ValidateSeams["runTurn"] = (req) => {
      rungs.push(req.pointers[0]?.rung ?? 0);
      return unfixable; // never fixes it
    };

    const result = await validateDraft(unfixable, ctx(), { runTurn: seat });

    // One repair turn, then deterministic validation drops the unresolved element.
    expect(rungs).toEqual([1]);
    expect(findEl(result.board, "f1")).toBeUndefined();
    expect(result.omissions.map((o) => o.elementId)).toEqual(["f1"]);
    expect(result.omissions[0]?.reason).toContain("`f1`");
    // The orphaned citation goes with it; the board carries no code_ref nothing cites.
    expect(findEl(result.board, "c1")).toBeUndefined();
    // Honest omission, not a blemish and not a throw.
    expect(result.blemishes).toEqual([]);
    expect(LADDER_RUNGS).toBe(1);
    expect(result.attempts).toBe(RETRY_CAP);
  });
});

// ── One-repair exhaustion → labeled blemishes, never a throw or block ─────────

describe("validateDraft — retry cap exhaustion", () => {
  it("ships a labeled blemish with attempts once the cap is hit, not a throw or a block", async () => {
    // A lint failure asks the seat once; its repair does not even parse, and the cap is
    // spent — so the schema issues ship as labeled blemishes rather than a throw.
    const dirty = board([el("p1", "prose", { markdown: "```ts\nconst x = 1;\n```" })]);
    let calls = 0;
    const seat: ValidateSeams["runTurn"] = () => {
      calls += 1;
      return { elements: [{ id: "x", kind: "code", data: { author } }] };
    };

    const result = await validateDraft(dirty, ctx(), { runTurn: seat });

    expect(calls).toBe(1);
    expect(RETRY_CAP).toBe(1);
    expect(result.attempts).toBe(RETRY_CAP);
    expect(result.blemishes.length).toBeGreaterThan(0);
    expect(result.blemishes[0]?.ruleId).toBe("schema-invalid");
    expect(result.blemishes[0]?.attempts).toBe(RETRY_CAP);
    // The board still ships (visible, never blocking).
    expect(result.board).toBeDefined();
  });

  it("re-asks with parse pointers when the seat's first return does not parse", async () => {
    // An out-of-palette kind fails parseDraft → the seat is re-asked with the
    // schema issues as pointers, then returns a clean board.
    const badKind = { elements: [{ id: "x", kind: "code", data: { author } }] };
    let sawParsePointer = false;
    const seat: ValidateSeams["runTurn"] = (req) => {
      if (req.pointers.some((p) => p.ruleId === undefined)) sawParsePointer = true;
      return cleanBoard();
    };
    const result = await validateDraft(badKind, ctx(), { runTurn: seat });
    expect(sawParsePointer).toBe(true);
    expect(result.blemishes).toEqual([]);
    expect(result.board.elements.map((e) => e.id)).toEqual(["f1", "c1"]);
  });
});

// ── The two gates run in order: lint → immutability ──────────────────────────

describe("validateDraft — gate ordering", () => {
  it("runs the post-process pass after the lint loop and immutability after it", async () => {
    const order: string[] = [];
    const seams: ValidateSeams = {
      runTurn: noRetry, // clean board — no retries
      postProcess: (b) => {
        order.push("post");
        // The editor illegally rewrites the typed finding's concern.
        return {
          ...(b as object),
          elements: b.elements.map((e) =>
            e.kind === "finding"
              ? {
                  ...e,
                  data: { ...(e.data as object), concern: "editor rewrote this typed field" },
                }
              : e,
          ),
        };
      },
    };

    const result = await validateDraft(cleanBoard(), ctx(), seams);

    expect(order).toEqual(["post"]);
    // Gate 2 caught the typed-data mutation (so it ran after post-process).
    expect(result.immutability.map((v) => v.ruleId)).toEqual(["typed-data-immutable"]);
  });

  it("checkImmutability passes when post-process only touches prose", () => {
    const before = cleanBoard();
    const after = board([
      finding("f1", "The refresh token is classified as an error before its code is read.", ["c1"]),
      codeRef("c1", "src/auth.ts", 11, 12),
      el("p1", "prose", { markdown: "an added prose flourish" }),
    ]);
    expect(checkImmutability(before, after)).toEqual([]);
  });

  it("discards a post-process result that invents a dangling element reference", async () => {
    const before = board([
      el("a1", "annotation", {
        code_ref: "c1",
        body: "The refresh path is annotated.",
      }),
      codeRef("c1", "src/auth.ts", 11, 12),
    ]);
    const result = await validateDraft(before, ctx(), {
      runTurn: noRetry,
      postProcess: (draft) => ({
        ...draft,
        elements: draft.elements.map((element) =>
          element.id === "a1"
            ? { ...element, data: { ...element.data, code_ref: "missing" } }
            : element,
        ),
      }),
    });

    expect(result.board).toEqual(before);
    expect(result.blemishes).toEqual([]);
    expect(result.immutability).toEqual([]);
  });

  it("checkImmutability flags a dropped typed element", () => {
    const before = cleanBoard();
    // The finding vanishes, so only the drop fires.
    const afterDropped = board([codeRef("c1", "src/auth.ts", 11, 12)]);
    expect(checkImmutability(before, afterDropped).map((v) => v.ruleId)).toEqual([
      "typed-data-immutable",
    ]);
  });

  // ── Finding 4: the bidirectional gate catches the probe's forgeries ──────
  it("checkImmutability catches a post-process-edited code_ref (finding 4 probe)", () => {
    const before = cleanBoard();
    const after = board([
      finding("f1", "The refresh token is classified as an error before its code is read.", ["c1"]),
      codeRef("c1", "src/auth.ts", 11, 99), // the editor forged the line span
    ]);
    expect(checkImmutability(before, after)).toEqual([
      {
        ruleId: "typed-data-immutable",
        elementRef: "c1",
        message: expect.stringContaining("altered typed `code_ref`"),
      },
    ]);
  });

  it("checkImmutability catches a forged typed element the editor introduced (finding 4)", () => {
    const before = cleanBoard();
    const after = cleanBoard(); // start from the clean board…
    const forged = board([...after.elements, finding("fake", "editor invented a finding", [])]);
    expect(checkImmutability(before, forged).map((v) => v.elementRef)).toEqual(["fake"]);
  });
});

// ── Finding 5: honest omission never ships a dangling reference ───────────────

describe("validateDraft — finding 5: the incoming-reference closure", () => {
  it("patches a survivor that cited a dropped code_ref, no dangling ref", async () => {
    // c1 overruns the 200-line file → citation-resolves fires on c1 every round;
    // f1 (clean concern) cites c1. The seat never fixes c1.
    const withBadRef = board([
      finding("f1", "The refresh token is classified before its code is read.", ["c1"]),
      codeRef("c1", "src/auth.ts", 11, 9999),
    ]);
    const seat: ValidateSeams["runTurn"] = () => withBadRef; // the one repair stays invalid

    const result = await validateDraft(withBadRef, ctx(), { runTurn: seat });

    // c1 is dropped; f1 survives but its citation was patched out — no dangling ref.
    expect(findEl(result.board, "c1")).toBeUndefined();
    const f1 = findEl(result.board, "f1");
    expect(f1).toBeDefined();
    expect((f1?.data as { code: string[] } | undefined)?.code).toEqual([]);
    expect(result.omissions.map((o) => o.elementId)).toContain("c1");
    // The final board re-parses clean — no dangling ref left for the wire boundary.
    expect(result.blemishes).toEqual([]);
  });
});

// ── Finding 6: failure paths never fabricate empty success ────────────────────

describe("validateDraft — finding 6: honest failure state", () => {
  it("labels unresolved parse failures as blemishes and reports everParsed=false", async () => {
    const garbage = { not: "a board" } as unknown; // never parses
    let calls = 0;
    const seat: ValidateSeams["runTurn"] = () => {
      calls += 1;
      return garbage;
    };

    const result = await validateDraft(garbage, ctx(), { runTurn: seat });

    expect(result.everParsed).toBe(false);
    expect(calls).toBe(1);
    expect(result.attempts).toBe(RETRY_CAP);
    // The unresolved schema issues ride as labeled blemishes — never an empty blemishes[].
    expect(result.blemishes.length).toBeGreaterThan(0);
    expect(result.blemishes.every((b) => b.ruleId === "schema-invalid")).toBe(true);
    // The board is the honest empty fallback; the CALLER surfaces failure from everParsed.
    expect(result.board.elements).toEqual([]);
  });

  it("a genuinely empty but PARSED board reports everParsed=true (a real empty lens)", async () => {
    const result = await validateDraft({ elements: [] }, ctx(), {
      runTurn: noRetry,
    });
    expect(result.everParsed).toBe(true);
    expect(result.blemishes).toEqual([]);
  });
});
