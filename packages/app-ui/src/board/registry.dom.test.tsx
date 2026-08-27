// @vitest-environment happy-dom
import type { HostElement } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { assertExcludedKind, Element, type ElementRegistry } from "./registry";

// Cluster 2 wires the dispatch mechanism, not the renderers (those are cluster 3),
// so the test supplies its own registry of marker renderers — one per board kind —
// and proves dispatch routes `element.kind` to the right slot. The two out-of-domain
// kinds never reach `Element` (its input is narrowed to `ElementOf<BoardKind>`): they
// are rejected as invalid data at the board-data seam (finding 4), and the loud
// `assertExcludedKind` guard THROWS rather than silently rendering nothing.

const author = { kind: "lens-agent", id: "l1" } as const;

/** A marker renderer per board kind — a `<span data-kind>` so the test can read
 *  which slot dispatch reached. Filling every key also exercises the Record's
 *  totality: this literal would not compile if a board kind were missing. */
const markerRegistry: ElementRegistry = {
  finding: ({ element }) => <span data-kind={element.kind}>finding</span>,
  decision: ({ element }) => <span data-kind={element.kind}>decision</span>,
  requirement: ({ element }) => <span data-kind={element.kind}>requirement</span>,
  noise_verdict: ({ element }) => <span data-kind={element.kind}>noise_verdict</span>,
  order_step: ({ element }) => <span data-kind={element.kind}>order_step</span>,
  section: ({ element }) => <span data-kind={element.kind}>section</span>,
  prose: ({ element }) => <span data-kind={element.kind}>prose</span>,
  callout: ({ element }) => <span data-kind={element.kind}>callout</span>,
  annotation: ({ element }) => <span data-kind={element.kind}>annotation</span>,
  message: ({ element }) => <span data-kind={element.kind}>message</span>,
  code_ref: ({ element }) => <span data-kind={element.kind}>code_ref</span>,
};

const proseEl: Extract<HostElement, { kind: "prose" }> = {
  id: "p1",
  kind: "prose",
  data: { author, markdown: "hi" },
};
const findingEl: Extract<HostElement, { kind: "finding" }> = {
  id: "f1",
  kind: "finding",
  data: { author, severity: "high", concern: "x", code: [], concurrence: [], status: "open" },
};

describe("Element — the registry dispatcher", () => {
  it("routes an element to its registered renderer", () => {
    const { container } = mount(<Element registry={markerRegistry} element={proseEl} />);
    expect(container.querySelector("[data-kind=prose]")?.textContent).toBe("prose");
  });

  it("dispatches each board kind to its own slot", () => {
    const { container } = mount(<Element registry={markerRegistry} element={findingEl} />);
    expect(container.querySelector("[data-kind=finding]")?.textContent).toBe("finding");
  });

  it("refuses an out-of-domain kind LOUDLY — no silent null (round_outcome → C9)", () => {
    // `Element`'s input is narrowed to `ElementOf<BoardKind>`, so an excluded kind is a
    // compile error there and cannot render as an empty hole. If one reaches the guard
    // (it never does past the board-data boundary) it throws — the autopsy-S4 inversion.
    expect(() => assertExcludedKind("round_outcome")).toThrow(/does not render/);
    expect(() => assertExcludedKind("review_comment")).toThrow(/does not render/);
  });
});
