import type { DraftBoard } from "@rennet/protocol";
import { parseDraft } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  carriedElementIds,
  DELTA_MARK_BASIS,
  isCarriedForward,
  removedSectionIds,
  stampDeltas,
} from "./compose";

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

  it("a regenerated board citing the same lines under the successor patchset carries the mark (ids kept; reminted ids below)", () => {
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

// ── D5: a mark keys on content and citations, never on element ids ───────────
// The test above keeps every id stable, so it cannot see the case a regeneration
// actually produces: a seat drafting afresh mints NEW ids for the same content.

describe("stampDeltas — marks survive reminted ids", () => {
  const withIds = (
    sectionId: string,
    refId: string,
    over: { title?: string; start?: number; symbol?: string } = {},
  ) =>
    draft([
      {
        id: sectionId,
        kind: "section",
        data: { author, title: over.title ?? "Auth", children: [refId] },
      },
      {
        id: refId,
        kind: "code_ref",
        data: {
          author,
          patchset_id: "ps-1",
          path: "src/auth.ts",
          side: "head",
          start_line: over.start ?? 11,
          end_line: (over.start ?? 11) + 1,
          ...(over.symbol === undefined ? {} : { symbol: over.symbol }),
        },
      },
    ]);
  const dataOf = (board: DraftBoard, id: string) =>
    board.elements.find((el) => el.id === id)?.data as
      | { delta?: unknown; delta_basis?: unknown }
      | undefined;

  it("a regenerated board with every id reminted, citing the same lines, carries no mark", () => {
    const previous = withIds("s1", "c1");
    const current = withIds("s9", "c9");
    const stamped = stampDeltas(previous, current);
    expect(dataOf(stamped, "s9")?.delta).toBeUndefined();
    // …and the previous section is not read as REMOVED either: same content, new id.
    expect(removedSectionIds(previous, current)).toEqual([]);
    expect(isCarriedForward(previous, stamped)).toBe(true);
  });

  it("a RETITLED section citing the same range is reworked, not a removal and a new section", () => {
    const previous = withIds("s1", "c1");
    const current = withIds("s9", "c9", { title: "Authentication" });
    // The signature differs (new title), the id differs (reminted), the title differs.
    // The shared citation is the ONLY thing left saying this is the same section, so this
    // is the case the citation keying exists for — without it the reader sees one section
    // vanish and an unrelated one appear.
    expect(dataOf(stampDeltas(previous, current), "s9")?.delta).toBe("reworked");
    expect(removedSectionIds(previous, current)).toEqual([]);
  });

  it("control: reminted ids with a changed symbol on the same range is reworked, not carried", () => {
    const previous = withIds("s1", "c1", { symbol: "login" });
    const stamped = stampDeltas(previous, withIds("s9", "c9", { symbol: "logout" }));
    expect(dataOf(stamped, "s9")?.delta).toBe("reworked");
  });

  // `symbol` is optional and seat-authored: a regeneration may rename it, or leave it out,
  // over the very same lines. It used to be part of the citation KEY, so doing that made the
  // section match nothing — new, with its predecessor reported removed — and the reader lost
  // the thread of a section that had not moved. It still moves the content signature (the
  // rework mark above), which is the mark a renamed anchor should leave.
  it("a renamed symbol on the same range is the SAME section, not a new one and a removal", () => {
    // Retitled too, so the title arm cannot be what carries it: the citation is.
    const previous = withIds("s1", "c1", { symbol: "login", title: "Auth" });
    const current = withIds("s9", "c9", { symbol: "logout", title: "Tokens" });
    expect(dataOf(stampDeltas(previous, current), "s9")?.delta).toBe("reworked");
    expect(removedSectionIds(previous, current)).toEqual([]);
    // …and dropping the anchor entirely is the same fact.
    const dropped = withIds("s9", "c9", { title: "Tokens" });
    expect(dataOf(stampDeltas(previous, dropped), "s9")?.delta).toBe("reworked");
    expect(removedSectionIds(previous, dropped)).toEqual([]);
  });

  // The title arm's cost, which is why it now applies only where nothing is cited: the board
  // vocabulary is small, and two generations both writing a "Findings" section about
  // different code is the ordinary case. Matching on the shared word made a genuinely new
  // section read as a rework and hid the old one's removal — both halves of the delta wrong
  // at once, silently.
  it("a section reusing a title over a different range is NEW, and the old one is removed", () => {
    const previous = withIds("s1", "c1", { title: "Findings", start: 11 });
    const current = withIds("s9", "c9", { title: "Findings", start: 40 });
    expect(dataOf(stampDeltas(previous, current), "s9")?.delta).toBe("new");
    expect(removedSectionIds(previous, current)).toEqual(["s1"]);
  });

  it("a section that cites nothing still matches on its title — that is all it has", () => {
    // Reminted ids, changed body, no citations anywhere: the title is the only remaining
    // evidence that this is the same section, so it is still allowed to be the answer.
    const prose = (sectionId: string, textId: string, markdown: string) =>
      draft([
        { id: sectionId, kind: "section", data: { author, title: "Overview", children: [textId] } },
        { id: textId, kind: "prose", data: { author, markdown } },
      ]);
    const previous = prose("s1", "p1", "The change reshapes the reader.");
    const current = prose("s9", "p9", "The change reshapes the reader and the writer.");
    expect(dataOf(stampDeltas(previous, current), "s9")?.delta).toBe("reworked");
    expect(removedSectionIds(previous, current)).toEqual([]);
  });

  it("control: reminted ids under a new title citing a new range is new, and the old section removed", () => {
    const previous = withIds("s1", "c1");
    const current = withIds("s9", "c9", { title: "Tokens", start: 40 });
    expect(dataOf(stampDeltas(previous, current), "s9")?.delta).toBe("new");
    expect(removedSectionIds(previous, current)).toEqual(["s1"]);
  });

  it("stamps every mark with the citation basis, and a carried section with neither", () => {
    const fresh = stampDeltas(undefined, withIds("s1", "c1"));
    expect(dataOf(fresh, "s1")).toMatchObject({ delta: "new", delta_basis: DELTA_MARK_BASIS });
    const carried = stampDeltas(withIds("s1", "c1"), fresh);
    expect(dataOf(carried, "s1")).not.toHaveProperty("delta");
    expect(dataOf(carried, "s1")).not.toHaveProperty("delta_basis");
  });
});
