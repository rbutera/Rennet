import { describe, expect, it } from "vitest";
import { carryQuoteAnchor } from "./quote-carry";

// B11 cluster 5 (task 5.3) — quote-match carry re-anchors a reworked span across a
// regenerated draft by REUSING the lineage matcher, fail-closed (exact-only carry).

describe("carryQuoteAnchor — re-anchor a span across a regenerated draft", () => {
  it("carries a byte-identical span to its new block when it moved", () => {
    const span = "the middle paragraph";
    // The rework regenerated the body and MOVED the span to the end (blocks reordered).
    const regenerated = "a new opening line\n\ntrailing thought\n\nthe middle paragraph";
    expect(carryQuoteAnchor(span, regenerated)).toBe("the middle paragraph");
  });

  it("carries across CRLF / trailing-whitespace noise (normalised quote match)", () => {
    const span = "keep this exactly";
    const regenerated = "intro\r\n\r\nkeep this exactly   \r\n\r\noutro";
    expect(carryQuoteAnchor(span, regenerated)).toBe("keep this exactly");
  });

  it("fails closed (null) when the span did not survive regeneration verbatim", () => {
    const span = "the original wording";
    const regenerated = "a completely rewritten paragraph\n\nwith nothing in common";
    expect(carryQuoteAnchor(span, regenerated)).toBeNull();
  });

  it("fails closed (null) when the span is ambiguous — two identical blocks", () => {
    const span = "duplicated line";
    const regenerated = "duplicated line\n\nsomething else\n\nduplicated line";
    // Two identical candidate blocks: path cannot disambiguate, so the matcher reopens.
    expect(carryQuoteAnchor(span, regenerated)).toBeNull();
  });

  it("returns null for an empty span or an empty draft", () => {
    expect(carryQuoteAnchor("", "some draft")).toBeNull();
    expect(carryQuoteAnchor("a span", "")).toBeNull();
  });
});
