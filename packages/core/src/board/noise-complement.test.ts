import type { Author, DraftElement } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { ChangedRegion } from "./lint";
import {
  deriveNoiseMembers,
  NOISE_SIBLING_LENSES,
  type SiblingCitations,
  unknowableComplementFailure,
} from "./noise-complement";

/**
 * The Noise board is the complement of the other four (D16), and the case this suite
 * exists for is the one the design most expects to ship: a sibling that FAILED did not
 * cite nothing, and treating its silence as an empty citation set would file un-reviewed
 * regions as skippable.
 *
 * Every fixture below is MULTI-REGION and multi-file on purpose. A single-region fixture
 * makes the subtraction invisible — every arm passes over a set of one — which is the
 * "fixture that contains the shape" lesson from CLAUDE.md.
 */

const author: Author = { kind: "lens-agent", id: "seat" };

const REGIONS: readonly ChangedRegion[] = [
  { path: "src/auth.ts", side: "head", start: 10, end: 14 },
  { path: "src/auth.ts", side: "head", start: 40, end: 44 },
  { path: "pnpm-lock.yaml", side: "head", start: 1, end: 900 },
  { path: "src/legacy.ts", side: "base", start: 5, end: 9 },
];

/** A board holding one `code_ref` per span it cites. */
const cites = (
  spans: readonly { path: string; side: "base" | "head"; start: number; end: number }[],
): readonly DraftElement[] =>
  spans.map(
    (span, index) =>
      ({
        id: `c${index}`,
        kind: "code_ref",
        data: {
          author,
          path: span.path,
          side: span.side,
          start_line: span.start,
          end_line: span.end,
        },
      }) as DraftElement,
  );

const settled = (
  lens: SiblingCitations["lens"],
  spans: Parameters<typeof cites>[0],
): SiblingCitations => ({ lens, kind: "settled", elements: cites(spans) });

const absent = (lens: SiblingCitations["lens"]): SiblingCitations => ({ lens, kind: "absent" });
const failed = (lens: SiblingCitations["lens"]): SiblingCitations => ({ lens, kind: "failed" });

/** Every sibling settled a board, citing nothing unless the caller says otherwise. */
const allSettled = (over: readonly SiblingCitations[] = []): SiblingCitations[] => {
  const byLens = new Map(over.map((sibling) => [sibling.lens, sibling]));
  return NOISE_SIBLING_LENSES.map(
    (lens) => byLens.get(lens) ?? { lens, kind: "settled" as const, elements: [] },
  );
};

const pathsOf = (regions: readonly ChangedRegion[]) =>
  regions.map((region) => `${region.path}:${region.side}:${region.start}-${region.end}`);

describe("the Noise board is the complement of the other four (D16)", () => {
  it("a region no sibling cited is a member, and one a sibling cited is not", () => {
    const membership = deriveNoiseMembers({
      regions: REGIONS,
      siblings: allSettled([
        // Flagged claims one of the two `src/auth.ts` regions, by overlapping it.
        settled("flagged", [{ path: "src/auth.ts", side: "head", start: 11, end: 12 }]),
      ]),
    });
    if (membership.kind !== "derived")
      throw new Error(`expected a derivation, got ${membership.kind}`);

    // The cited region is gone; the other three — including the OTHER region of the very
    // same file — are members. A per-file subtraction would have taken both.
    expect(pathsOf(membership.members)).toEqual([
      "src/auth.ts:head:40-44",
      "pnpm-lock.yaml:head:1-900",
      "src/legacy.ts:base:5-9",
    ]);
  });

  it("a base-side citation does not claim the head-side region at the same lines", () => {
    // The sides are separate inventories, and a complement that collapsed them would hand
    // the reviewer a board missing a region nobody read. These two regions carry no
    // `hunk`, so they are two changes that happen to share a path and a line range —
    // which is all a caller with no diff index can say. Two SIDES OF ONE HUNK are the
    // suite below, and they answer differently on purpose.
    const membership = deriveNoiseMembers({
      regions: [
        { path: "src/legacy.ts", side: "base", start: 5, end: 9 },
        { path: "src/legacy.ts", side: "head", start: 5, end: 9 },
      ],
      siblings: allSettled([
        settled("sequence", [{ path: "src/legacy.ts", side: "base", start: 5, end: 9 }]),
      ]),
    });
    if (membership.kind !== "derived") throw new Error("expected a derivation");
    expect(pathsOf(membership.members)).toEqual(["src/legacy.ts:head:5-9"]);
  });

  it("every region cited leaves an empty complement, which is the no-noise settlement", () => {
    const membership = deriveNoiseMembers({
      regions: REGIONS,
      siblings: allSettled([settled("sequence", [...REGIONS])]),
    });
    expect(membership).toEqual({ kind: "derived", members: [] });
  });

  it("a declared absence subtracts an empty set, and the lane still gets a board", () => {
    // D16d's safe half: `no-decisions` is a POSITIVE statement that Decisions cites
    // nothing, so the complement is knowable and the board is drafted.
    const membership = deriveNoiseMembers({
      regions: REGIONS,
      siblings: allSettled([absent("decisions")]),
    });
    if (membership.kind !== "derived") throw new Error("a declared absence must not block");
    expect(membership.members).toHaveLength(REGIONS.length);
  });

  it("a FAILED sibling is not an empty citation set: the complement is refused by name", () => {
    // The trap. Flagged failed, so what it would have cited is unknown, and a board built
    // over the remainder would present un-reviewed regions as safely skippable.
    const membership = deriveNoiseMembers({
      regions: REGIONS,
      siblings: allSettled([failed("flagged")]),
    });
    expect(membership).toEqual({ kind: "unknowable", unknown: ["flagged"] });
    expect(unknowableComplementFailure(["flagged"])).toContain("flagged");
    expect(unknowableComplementFailure(["flagged"])).toContain("skippable");
  });

  it("two failed siblings are both named, so the reviewer knows where the retries are", () => {
    const membership = deriveNoiseMembers({
      regions: REGIONS,
      siblings: allSettled([failed("flagged"), failed("design")]),
    });
    expect(membership).toEqual({ kind: "unknowable", unknown: ["design", "flagged"] });
    const failure = unknowableComplementFailure(["design", "flagged"]);
    expect(failure).toContain("design, flagged");
    expect(failure).toContain("lanes");
  });

  it("a failure outranks a rich set of settlements — it is not diluted by its siblings", () => {
    // The shape the "partial complement" defect actually takes: three lanes cited plenty,
    // one died, and the remainder LOOKS like a normal noise board.
    const membership = deriveNoiseMembers({
      regions: REGIONS,
      siblings: allSettled([
        settled("design", [{ path: "src/auth.ts", side: "head", start: 10, end: 14 }]),
        settled("sequence", [{ path: "src/auth.ts", side: "head", start: 40, end: 44 }]),
        absent("decisions"),
        failed("flagged"),
      ]),
    });
    expect(membership.kind).toBe("unknowable");
  });
});

/**
 * #864 — the unit of the complement is the HUNK, not the side.
 *
 * The live defect: a one-hunk change (`@@ -1,6 +1,6 @@`), Sequence cited head 3-6, and the
 * host still filed base 1-6 as a Noise member — then spent a 75-second Codex seat turn
 * writing a board that called a sibling-cited change noise. Two consequences: `no-noise`
 * was unreachable for any change containing a modification, and the Noise board
 * systematically re-filed what the other lenses had just read.
 *
 * The fixtures here all carry a MODIFIED hunk cited on ONE side, which is the shape every
 * pre-existing fixture was missing — they were additions, and an addition has one side, so
 * the subtraction and the placement could not tell the two rules apart.
 */
describe("the unit of the complement is the hunk, not the side (#864)", () => {
  /** `@@ -1,6 +1,6 @@` on one file: one hunk, two sides, one change. */
  const MODIFIED: readonly ChangedRegion[] = [
    { path: "docs/README.md", side: "head", start: 1, end: 6, hunk: "h1" },
    { path: "docs/README.md", side: "base", start: 1, end: 6, hunk: "h1" },
  ];

  it("a head-side citation cancels the hunk's base side, so no-noise is reachable", () => {
    const membership = deriveNoiseMembers({
      regions: MODIFIED,
      siblings: allSettled([
        settled("sequence", [{ path: "docs/README.md", side: "head", start: 3, end: 6 }]),
      ]),
    });
    // The live bug returned `[docs/README.md:base:1-6]` here. Empty is the `no-noise`
    // settlement (D16e) — the four lanes between them read the whole change.
    expect(membership).toEqual({ kind: "derived", members: [] });
  });

  it("a BASE-side citation cancels the head side too — the rule is not one-directional", () => {
    const membership = deriveNoiseMembers({
      regions: MODIFIED,
      siblings: allSettled([
        settled("flagged", [{ path: "docs/README.md", side: "base", start: 1, end: 2 }]),
      ]),
    });
    expect(membership).toEqual({ kind: "derived", members: [] });
  });

  it("an UNCITED modified hunk is filed ONCE, on its head side", () => {
    // The placement half, and the one that halves the member list: filing both sides put
    // the same change on the board twice under two line ranges. On the 95-file drive that
    // was 1,259 code_ref + 1,259 noise_verdict members against ~630 real changes, and a
    // seat whose only verb moves one member at a time.
    const membership = deriveNoiseMembers({ regions: MODIFIED, siblings: allSettled() });
    if (membership.kind !== "derived") throw new Error("expected a derivation");
    expect(pathsOf(membership.members)).toEqual(["docs/README.md:head:1-6"]);
  });

  it("a pure DELETION has no head side, so it files its base side", () => {
    const membership = deriveNoiseMembers({
      regions: [{ path: "src/gone.ts", side: "base", start: 1, end: 12, hunk: "h9" }],
      siblings: allSettled(),
    });
    if (membership.kind !== "derived") throw new Error("expected a derivation");
    expect(pathsOf(membership.members)).toEqual(["src/gone.ts:base:1-12"]);
  });

  it("a rename's two base names are one change, filed once and cancelled together", () => {
    // `changedRegions` emits a renamed file base side under BOTH names so either
    // resolves. They are one hunk, so the complement must not file the change twice.
    const renamed: readonly ChangedRegion[] = [
      { path: "src/new.ts", side: "head", start: 10, end: 11, hunk: "h2" },
      { path: "src/old.ts", side: "base", start: 10, end: 11, hunk: "h2" },
      { path: "src/new.ts", side: "base", start: 10, end: 11, hunk: "h2" },
    ];
    expect(deriveNoiseMembers({ regions: renamed, siblings: allSettled() })).toMatchObject({
      members: [renamed[0]],
    });
    expect(
      deriveNoiseMembers({
        regions: renamed,
        siblings: allSettled([
          settled("design", [{ path: "src/old.ts", side: "base", start: 10, end: 10 }]),
        ]),
      }),
    ).toEqual({ kind: "derived", members: [] });
  });

  it("cancelling one hunk leaves its neighbours: the key groups, it does not collapse", () => {
    // The failure mode of a too-broad key. If regions grouped by PATH, or if every region
    // shared one key, a single citation would empty the whole complement — which reads as
    // `no-noise` and is the same class of harm in the other direction.
    const twoHunks: readonly ChangedRegion[] = [
      { path: "src/a.ts", side: "head", start: 1, end: 4, hunk: "h1" },
      { path: "src/a.ts", side: "base", start: 1, end: 3, hunk: "h1" },
      { path: "src/a.ts", side: "head", start: 40, end: 44, hunk: "h2" },
      { path: "src/a.ts", side: "base", start: 40, end: 42, hunk: "h2" },
    ];
    const membership = deriveNoiseMembers({
      regions: twoHunks,
      siblings: allSettled([
        settled("design", [{ path: "src/a.ts", side: "head", start: 2, end: 3 }]),
      ]),
    });
    if (membership.kind !== "derived") throw new Error("expected a derivation");
    expect(pathsOf(membership.members)).toEqual(["src/a.ts:head:40-44"]);
  });

  it("a FAILED sibling still refuses the complement, keys or no keys", () => {
    // The keying must not reach the D16d branch: silence is still not an empty set.
    expect(
      deriveNoiseMembers({ regions: MODIFIED, siblings: allSettled([failed("flagged")]) }),
    ).toEqual({ kind: "unknowable", unknown: ["flagged"] });
  });
});
