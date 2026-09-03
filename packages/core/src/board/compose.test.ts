import type { DraftBoard } from "@rennet/protocol";
import { parseDraft } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { carriedElementIds, isCarriedForward, removedSectionIds, stampDeltas } from "./compose";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Every board is built through `parseDraft` so the inputs are schema-valid by
// construction — no casts.

const author = { kind: "lens-agent", id: "seat" };

const codeRef = (id: string, path: string, start: number, end: number) => ({
  id,
  kind: "code_ref",
  data: { author, patchset_id: "ps-1", path, side: "head", start_line: start, end_line: end },
});

/** Parse a raw board or throw — keeps every fixture schema-valid, no `as`. */
const draft = (elements: unknown[], extra: Record<string, unknown> = {}): DraftBoard => {
  const parsed = parseDraft({ elements, ...extra });
  if (!parsed.ok) throw new Error(`fixture not schema-valid: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
};

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

// ── D5: a delta mark keys on what an element cites, never on the patchset id ──

describe("stampDeltas — marks key on (path, side, start, end)", () => {
  const section = (children: string[]) => ({
    id: "s1",
    kind: "section",
    data: { author, title: "Auth", children },
  });
  const citing = (patchsetId: string, path: string, start: number, end: number) =>
    draft([
      section(["c1"]),
      {
        id: "c1",
        kind: "code_ref",
        data: {
          author,
          patchset_id: patchsetId,
          path,
          side: "head",
          start_line: start,
          end_line: end,
        },
      },
    ]);
  const deltaOf = (board: DraftBoard, id: string) =>
    (board.elements.find((el) => el.id === id)?.data as { delta?: unknown } | undefined)?.delta;

  it("a regenerated board citing the same lines under the successor patchset carries the mark", () => {
    const previous = citing("ps-1", "src/auth.ts", 11, 12);
    const current = citing("ps-2", "src/auth.ts", 11, 12);
    expect(deltaOf(stampDeltas(previous, current), "s1")).toBeUndefined();
    expect(isCarriedForward(previous, stampDeltas(previous, current))).toBe(true);
  });

  it("control: the same element citing a different range is reworked", () => {
    const previous = citing("ps-1", "src/auth.ts", 11, 12);
    expect(deltaOf(stampDeltas(previous, citing("ps-2", "src/auth.ts", 40, 41)), "s1")).toBe(
      "reworked",
    );
    expect(deltaOf(stampDeltas(previous, citing("ps-2", "src/other.ts", 11, 12)), "s1")).toBe(
      "reworked",
    );
  });
});
