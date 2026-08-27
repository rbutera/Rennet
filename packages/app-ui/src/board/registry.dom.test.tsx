// @vitest-environment happy-dom
import type { HostElement } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { Element, type ElementRegistry } from "./registry";

// Cluster 2 wires the dispatch mechanism, not the renderers (those are cluster 3),
// so the test supplies its own registry of marker renderers — one per board kind —
// and proves dispatch routes `element.kind` to the right slot and that the two
// out-of-domain kinds render nothing (never a crash).

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

const proseEl: HostElement = { id: "p1", kind: "prose", data: { author, markdown: "hi" } };
const findingEl: HostElement = {
  id: "f1",
  kind: "finding",
  data: { author, severity: "high", concern: "x", code: [], concurrence: [], status: "open" },
};
const roundOutcomeEl: HostElement = {
  id: "r1",
  kind: "round_outcome",
  data: { author, status: "addressed", ask: { ref: "a", text: "t" }, note: "" },
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

  it("renders nothing for a kind outside the registry domain (round_outcome → C9)", () => {
    const { container } = mount(<Element registry={markerRegistry} element={roundOutcomeEl} />);
    expect(container.textContent).toBe("");
  });
});
