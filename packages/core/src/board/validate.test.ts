import type { DraftBoard, DraftElement } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { LintContext, LintHunk } from "./lint";
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

const HUNKS: LintHunk[] = [
  { id: "h1", path: "src/auth.ts", newStart: 10, newLines: 5 },
  { id: "h2", path: "src/util.ts", newStart: 1, newLines: 3 },
];

const ctx = (over: Partial<LintContext> = {}): LintContext => ({
  lens: "flagged",
  hunks: HUNKS,
  files: new Map([
    ["src/auth.ts", 200],
    ["src/util.ts", 50],
  ]),
  ...over,
});

/** A board lint passes clean: a grounded finding + its citation, h2 skipped with a real reason. */
const cleanBoard = (over: Record<string, unknown> = {}): DraftBoard =>
  board(
    [
      finding("f1", "The refresh token is classified as an error before its code is read.", ["c1"]),
      codeRef("c1", "src/auth.ts", 11, 12),
    ],
    {
      skippedHunks: [
        { hunk: "h2", reason: "The util rename is mechanical — the Noise board owns it." },
      ],
      ...over,
    },
  );

/** A seat that must never be asked (a clean board takes no retries). */
const noRetry: ValidateSeams["runTurn"] = () => {
  throw new Error("runTurn must not be called");
};

const findEl = (b: DraftBoard, id: string): DraftElement | undefined =>
  b.elements.find((e) => e.id === id);
const skips = (b: DraftBoard): { hunk: string; reason: string }[] =>
  ((b as { skippedHunks?: unknown }).skippedHunks as { hunk: string; reason: string }[]) ?? [];

// ── A clean draft passes straight through ─────────────────────────────────────

describe("validateDraft — the clean path", () => {
  it("a clean draft ships unchanged, no retries, no blemishes, no omissions", async () => {
    const result = await validateDraft(cleanBoard(), ctx(), { runTurn: noRetry });
    expect(result.attempts).toBe(0);
    expect(result.blemishes).toEqual([]);
    expect(result.omissions).toEqual([]);
    expect(result.immutability).toEqual([]);
    expect(result.composition).toEqual([]);
    expect(result.board.elements.map((e) => e.id)).toEqual(["f1", "c1"]);
  });
});

// ── Retry + freeze: the patched element re-lints; frozen elements are untouched ─

describe("validateDraft — retry channel + freeze", () => {
  it("returns pointers, re-lints the patched element, and never re-drafts a frozen one", async () => {
    // f1 + c1 lint clean (freeze); p1 carries code bytes (no-code-bytes fires).
    const dirty = board(
      [
        finding("f1", "The refresh token is classified before its code is read.", ["c1"]),
        codeRef("c1", "src/auth.ts", 11, 12),
        el("p1", "prose", { markdown: "```ts\nconst x = 1;\n```" }),
      ],
      { skippedHunks: [{ hunk: "h2", reason: "The util rename is mechanical — Noise owns it." }] },
    );

    let seen: RetryRequest | undefined;
    const seat: ValidateSeams["runTurn"] = (req) => {
      seen = req;
      // The seat fixes p1 AND tries to mutate the frozen f1 — the mutation must be ignored.
      return board(
        [
          finding("f1", "MUTATED — the seat should not be allowed to change this frozen finding.", [
            "c1",
          ]),
          codeRef("c1", "src/auth.ts", 11, 12),
          el("p1", "prose", { markdown: "The token is read before classification." }),
        ],
        {
          skippedHunks: [{ hunk: "h2", reason: "The util rename is mechanical — Noise owns it." }],
        },
      );
    };

    const result = await validateDraft(dirty, ctx(), { runTurn: seat });

    // The channel carried a ZodError-shaped pointer at the offending prose field.
    expect(seen).toBeDefined();
    expect(seen?.pointers?.[0]?.ruleId).toBe("no-code-bytes");
    expect(seen?.pointers?.[0]?.path).toEqual(["elements", 2, "data", "markdown"]);
    expect(seen?.pointers?.[0]?.rung).toBe(1);

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

// ── The 4-rung ladder ends in an honest omission ─────────────────────────────

describe("validateDraft — the escalation ladder", () => {
  it("escalates rung-by-rung, then omits an unfixable element and sheds its hunks", async () => {
    // f1's concern cites a line past the file (citation-resolves) and the seat
    // stubbornly returns the same broken board every turn.
    const unfixable = board(
      [
        finding("f1", "See the overrun at src/auth.ts:9999 — this never resolves.", ["c1"]),
        codeRef("c1", "src/auth.ts", 11, 12),
      ],
      { skippedHunks: [{ hunk: "h2", reason: "The util rename is mechanical — Noise owns it." }] },
    );

    const rungs: number[] = [];
    const seat: ValidateSeams["runTurn"] = (req) => {
      rungs.push(req.pointers[0]?.rung ?? 0);
      return unfixable; // never fixes it
    };

    const result = await validateDraft(unfixable, ctx(), { runTurn: seat });

    // Four rungs of re-ask (1..4), then the element is dropped.
    expect(rungs).toEqual([1, 2, 3, 4]);
    expect(findEl(result.board, "f1")).toBeUndefined();
    expect(result.omissions.map((o) => o.elementId)).toEqual(["f1"]);
    // f1 taught h1 (via c1 @ 11-12 overlapping h1 @ 10-14) → h1 is now skipped.
    expect(result.omissions[0]?.hunks).toEqual(["h1"]);
    expect(skips(result.board).some((s) => s.hunk === "h1")).toBe(true);
    // Honest omission, not a blemish and not a throw.
    expect(result.blemishes).toEqual([]);
    expect(result.attempts).toBe(LADDER_RUNGS + 1);
  });
});

// ── Cap-10 exhaustion → labeled blemishes, never a throw, never a block ───────

describe("validateDraft — retry cap exhaustion", () => {
  it("ships a labeled blemish with attempts once the cap is hit, not a throw or a block", async () => {
    // A board-level violation (boilerplate skip reason) never escalates to an
    // element drop, so it survives every round until the global cap bites.
    const nagging = board([], { skippedHunks: [{ hunk: "h2", reason: "n/a" }] });
    const seat: ValidateSeams["runTurn"] = () => nagging; // never fixed

    const result = await validateDraft(nagging, ctx(), { runTurn: seat });

    expect(result.attempts).toBe(RETRY_CAP);
    expect(result.blemishes.length).toBeGreaterThan(0);
    expect(result.blemishes[0]?.ruleId).toBe("skip-reason-specific");
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

// ── The three gates run in order: lint → immutability → composition ──────────

describe("validateDraft — gate ordering", () => {
  it("runs immutability after the lint loop and composition after immutability", async () => {
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
      compositionGate: (b) => {
        order.push("compose");
        // Gate 3 sees the post-processed board (proves it ran last).
        expect((findEl(b, "f1")?.data as { concern: string } | undefined)?.concern).toBe(
          "editor rewrote this typed field",
        );
        return [
          { ruleId: "every-hunk", elementRef: "/coverage", message: "a hunk is taught by no lens" },
        ];
      },
    };

    const result = await validateDraft(cleanBoard(), ctx(), seams);

    // Ordering: post-process (between lint and immutability) then composition.
    expect(order).toEqual(["post", "compose"]);
    // Gate 2 caught the typed-data mutation (so it ran after post-process).
    expect(result.immutability.map((v) => v.ruleId)).toEqual(["typed-data-immutable"]);
    // Gate 3's seam violation is surfaced.
    expect(result.composition.map((v) => v.ruleId)).toEqual(["every-hunk"]);
  });

  it("checkImmutability passes when post-process only touches prose", () => {
    const before = cleanBoard();
    const after = board(
      [
        finding("f1", "The refresh token is classified as an error before its code is read.", [
          "c1",
        ]),
        codeRef("c1", "src/auth.ts", 11, 12),
        el("p1", "prose", { markdown: "an added prose flourish" }),
      ],
      { skippedHunks: [{ hunk: "h2", reason: "The util rename is mechanical — Noise owns it." }] },
    );
    expect(checkImmutability(before, after)).toEqual([]);
  });

  it("checkImmutability flags a dropped typed element", () => {
    const before = cleanBoard();
    // The finding vanishes; the skip set is kept, so only the drop fires.
    const afterDropped = board([codeRef("c1", "src/auth.ts", 11, 12)], {
      skippedHunks: [{ hunk: "h2", reason: "The util rename is mechanical — Noise owns it." }],
    });
    expect(checkImmutability(before, afterDropped).map((v) => v.ruleId)).toEqual([
      "typed-data-immutable",
    ]);
  });

  // ── Finding 4: the bidirectional gate catches the probe's forgeries ──────
  it("checkImmutability catches a post-process-edited code_ref (finding 4 probe)", () => {
    const before = cleanBoard();
    const after = board(
      [
        finding("f1", "The refresh token is classified as an error before its code is read.", [
          "c1",
        ]),
        codeRef("c1", "src/auth.ts", 11, 99), // the editor forged the line span
      ],
      { skippedHunks: [{ hunk: "h2", reason: "The util rename is mechanical — Noise owns it." }] },
    );
    expect(checkImmutability(before, after)).toEqual([
      {
        ruleId: "typed-data-immutable",
        elementRef: "c1",
        message: expect.stringContaining("altered typed `code_ref`"),
      },
    ]);
  });

  it("checkImmutability catches an invented skippedHunks entry (finding 4 probe)", () => {
    const before = cleanBoard();
    // Same elements, but the editor invented coverage for h1 it never taught.
    const after = cleanBoard({
      skippedHunks: [
        { hunk: "h2", reason: "The util rename is mechanical — the Noise board owns it." },
        { hunk: "h1", reason: "invented by the editor" },
      ],
    });
    expect(checkImmutability(before, after).map((v) => v.elementRef)).toEqual(["/skippedHunks"]);
  });

  it("checkImmutability catches a forged typed element the editor introduced (finding 4)", () => {
    const before = cleanBoard();
    const after = cleanBoard({}); // start from the clean board…
    const forged = board([...after.elements, finding("fake", "editor invented a finding", [])], {
      skippedHunks: skips(after),
    });
    expect(checkImmutability(before, forged).map((v) => v.elementRef)).toEqual(["fake"]);
  });
});
