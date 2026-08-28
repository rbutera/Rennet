import type { DraftBoard } from "@rennet/protocol";
import { parseDraft } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  assertCoverage,
  carriedElementIds,
  isCarriedForward,
  removedSectionIds,
  stampDeltas,
} from "./compose";
import type { LintHunk } from "./lint";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Every board is built through `parseDraft` so the inputs are schema-valid by
// construction — no casts.

const author = { kind: "lens-agent", id: "seat" };

const codeRef = (id: string, path: string, start: number, end: number) => ({
  id,
  kind: "code_ref",
  data: { author, patchset_id: "ps-1", path, side: "head", start_line: start, end_line: end },
});

const baseRef = (id: string, path: string, start: number, end: number) => ({
  id,
  kind: "code_ref",
  data: { author, patchset_id: "ps-1", path, side: "base", start_line: start, end_line: end },
});

/** Parse a raw board or throw — keeps every fixture schema-valid, no `as`. */
const draft = (elements: unknown[], extra: Record<string, unknown> = {}): DraftBoard => {
  const parsed = parseDraft({ elements, ...extra });
  if (!parsed.ok) throw new Error(`fixture not schema-valid: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
};

const HUNKS: LintHunk[] = [
  { id: "h1", path: "src/auth.ts", newStart: 10, newLines: 5 },
  { id: "h2", path: "src/util.ts", newStart: 1, newLines: 3 },
];

// ── Coverage assertion (L18) ─────────────────────────────────────────────────

describe("assertCoverage", () => {
  it("passes when every hunk is taught or skipped across the lens boards", () => {
    const flagged = draft([codeRef("c1", "src/auth.ts", 11, 12)]); // teaches h1
    const noise = draft([], { skippedHunks: [{ hunk: "h2", reason: "generated fixture" }] }); // skips h2
    expect(assertCoverage([flagged, noise], HUNKS)).toEqual([]);
  });

  it("fails the assert for a hunk covered by no lens", () => {
    const flagged = draft([codeRef("c1", "src/auth.ts", 11, 12)]); // teaches h1 only
    const violations = assertCoverage([flagged], HUNKS);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ruleId: "every-hunk-covered",
      elementRef: "/hunks/h2",
    });
  });

  it("counts a hunk covered by ANY lens (taught on one, absent on others)", () => {
    const flagged = draft([codeRef("c1", "src/auth.ts", 11, 12)]); // teaches h1
    const design = draft([codeRef("c2", "src/util.ts", 1, 2)]); // teaches h2
    expect(assertCoverage([flagged, design], HUNKS)).toEqual([]);
  });

  // ── Finding 8: side + deletion geometry ──────────────────────────────────
  it("a BASE-side citation does not falsely cover an addition hunk (finding 8)", () => {
    // h1 is a pure addition on the head side (new image 10..14, no old image).
    const addHunk: LintHunk[] = [
      { id: "h1", path: "src/auth.ts", newStart: 10, newLines: 5, oldStart: 10, oldLines: 0 },
    ];
    // A base-side ref whose OLD-image lines happen to land on 10..14 must NOT cover it.
    const board = draft([baseRef("c1", "src/auth.ts", 10, 14)]);
    expect(assertCoverage([board], addHunk)).toHaveLength(1);
    // The matching HEAD-side ref does cover it.
    const head = draft([codeRef("c2", "src/auth.ts", 10, 14)]);
    expect(assertCoverage([head], addHunk)).toEqual([]);
  });

  it("a DELETION-only hunk is teachable only from the base side (finding 8)", () => {
    // h1 has no new image (deletion), old image 20..24 on the base path.
    const delHunk: LintHunk[] = [
      { id: "h1", path: "src/auth.ts", newStart: 20, newLines: 0, oldStart: 20, oldLines: 5 },
    ];
    // A head-side ref can never teach it — there is no new image.
    const head = draft([codeRef("c1", "src/auth.ts", 20, 24)]);
    expect(assertCoverage([head], delHunk)).toHaveLength(1);
    // A base-side ref citing the old image does.
    const base = draft([baseRef("c2", "src/auth.ts", 20, 24)]);
    expect(assertCoverage([base], delHunk)).toEqual([]);
  });

  it("a RENAME resolves each side against its own path (finding 8)", () => {
    // File moved old.ts → new.ts; the hunk edits both images.
    const renameHunk: LintHunk[] = [
      {
        id: "h1",
        path: "src/new.ts",
        newStart: 5,
        newLines: 3,
        previousPath: "src/old.ts",
        oldStart: 5,
        oldLines: 3,
      },
    ];
    // A base-side ref must cite the PREVIOUS path; the current path does not resolve.
    expect(assertCoverage([draft([baseRef("c1", "src/new.ts", 5, 7)])], renameHunk)).toHaveLength(
      1,
    );
    expect(assertCoverage([draft([baseRef("c2", "src/old.ts", 5, 7)])], renameHunk)).toEqual([]);
    // A head-side ref cites the CURRENT path.
    expect(assertCoverage([draft([codeRef("c3", "src/new.ts", 5, 7)])], renameHunk)).toEqual([]);
  });
});

// ── Verbatim carry ───────────────────────────────────────────────────────────

describe("carriedElementIds", () => {
  it("carries a stable-id element byte-identical", () => {
    const prev = draft([codeRef("c1", "src/auth.ts", 11, 12)]);
    const curr = draft([codeRef("c1", "src/auth.ts", 11, 12)]);
    expect(carriedElementIds(prev, curr)).toEqual(new Set(["c1"]));
  });

  it("does not carry a same-id element whose content changed", () => {
    const prev = draft([codeRef("c1", "src/auth.ts", 11, 12)]);
    const curr = draft([codeRef("c1", "src/auth.ts", 11, 20)]); // range changed
    expect(carriedElementIds(prev, curr)).toEqual(new Set());
  });
});

// ── Delta stamps (R58) ───────────────────────────────────────────────────────

const section = (id: string, title: string, children: string[]) => ({
  id,
  kind: "section",
  data: { author, title, children },
});

const deltaOf = (board: DraftBoard, id: string): unknown => {
  const el = board.elements.find((e) => e.id === id);
  return (el?.data as { delta?: unknown } | undefined)?.delta;
};

describe("stampDeltas", () => {
  it("stamps every section `new` on the first generation", () => {
    const curr = draft([section("s1", "Findings", ["f1"]), codeRef("f1", "src/auth.ts", 11, 12)]);
    expect(deltaOf(stampDeltas(undefined, curr), "s1")).toBe("new");
  });

  it("stamps a section `reworked` when its subtree changed", () => {
    const prev = draft([section("s1", "Findings", ["c1"]), codeRef("c1", "src/auth.ts", 11, 12)]);
    const curr = draft([section("s1", "Findings", ["c1"]), codeRef("c1", "src/auth.ts", 11, 20)]);
    expect(deltaOf(stampDeltas(prev, curr), "s1")).toBe("reworked");
  });

  it("leaves an unchanged section unstamped (absence = carried)", () => {
    const prev = draft([section("s1", "Findings", ["c1"]), codeRef("c1", "src/auth.ts", 11, 12)]);
    const curr = draft([section("s1", "Findings", ["c1"]), codeRef("c1", "src/auth.ts", 11, 12)]);
    expect(deltaOf(stampDeltas(prev, curr), "s1")).toBeUndefined();
  });

  it("treats a carried section as carried even if it carried a stamp last generation", () => {
    const prev = draft([
      {
        id: "s1",
        kind: "section",
        data: { author, title: "Findings", children: [], delta: "new" },
      },
    ]);
    const curr = draft([section("s1", "Findings", [])]);
    expect(deltaOf(stampDeltas(prev, curr), "s1")).toBeUndefined();
  });

  // C15 3.3 — the lane label's source of truth. `isCarriedForward` reads the stamps
  // `stampDeltas` just wrote, so the live "carrying forward" lane and the board's own
  // section markers are one signal and cannot disagree.
  it("isCarriedForward: true only when a prior exists and NO section was stamped", () => {
    const prev = draft([section("s1", "Findings", ["c1"]), codeRef("c1", "src/auth.ts", 11, 12)]);
    const same = draft([section("s1", "Findings", ["c1"]), codeRef("c1", "src/auth.ts", 11, 12)]);
    const moved = draft([section("s1", "Findings", ["c1"]), codeRef("c1", "src/auth.ts", 11, 20)]);
    expect(isCarriedForward(prev, stampDeltas(prev, same))).toBe(true);
    // The lie this guards: a changed section must never read as carried.
    expect(isCarriedForward(prev, stampDeltas(prev, moved))).toBe(false);
    // A first generation carries nothing — there is nothing to carry from.
    expect(isCarriedForward(undefined, stampDeltas(undefined, same))).toBe(false);
  });

  // ── REMOVALS (review finding 3) ───────────────────────────────────────────
  //
  // A delta stamp can only live on a section that still exists, so a round that DELETED a
  // section stamps nothing at all — and the board then claimed to be "carrying forward"
  // content that is no longer on it. That is the honest-present ruling inverted: never
  // describe content that is not there.
  it("names the sections a regeneration REMOVED — the half the stamps cannot express", () => {
    const prev = draft([
      section("s1", "Findings", ["c1"]),
      section("s2", "Retired", []),
      codeRef("c1", "src/auth.ts", 11, 12),
    ]);
    const deleted = draft([
      section("s1", "Findings", ["c1"]),
      codeRef("c1", "src/auth.ts", 11, 12),
    ]);
    expect(removedSectionIds(prev, deleted)).toEqual(["s2"]);
    // …and it tracks the boards rather than being a constant: nothing went away here.
    expect(removedSectionIds(prev, prev)).toEqual([]);
  });

  it("a DELETION-ONLY round does not read as carrying forward", () => {
    const prev = draft([
      section("s1", "Findings", ["c1"]),
      section("s2", "Retired", []),
      codeRef("c1", "src/auth.ts", 11, 12),
    ]);
    // Every surviving section is byte-identical, so `stampDeltas` writes NOTHING: the only
    // change this round made was to take `s2` away.
    const deleted = draft([
      section("s1", "Findings", ["c1"]),
      codeRef("c1", "src/auth.ts", 11, 12),
    ]);
    const stamped = stampDeltas(prev, deleted);
    expect(stamped.elements.filter((el) => "delta" in (el.data as object))).toEqual([]);
    // THE LIE THIS GUARDS: with no stamps to read, the board used to claim it carried
    // everything forward — over a section it had just dropped.
    expect(isCarriedForward(prev, stamped)).toBe(false);
  });

  it("emits no sixth composed board — it returns the same board, sections stamped", () => {
    const curr = draft([section("s1", "Findings", [])]);
    const out = stampDeltas(undefined, curr);
    expect(out.elements.map((e) => e.id)).toEqual(["s1"]);
    expect(out.elements).toHaveLength(1);
  });
});
