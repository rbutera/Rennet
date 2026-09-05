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
    // the reviewer a board missing a region nobody read.
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
