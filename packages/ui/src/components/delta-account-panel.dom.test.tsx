// @vitest-environment happy-dom
//
// The delta re-review account panel (issue #73): it renders the deterministic account
// at the top of a successor review — what moved per ask + what changed beyond the asks
// — and each item anchors (navigates the diff to that path). It gates nothing.
import type { DeltaAccount } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { DeltaAccountPanel } from "./delta-account-panel";

const account: DeltaAccount = {
  asks: [
    { path: "a.ts", type: "request-change", summary: "Rename the export", status: "addressed" },
    { path: "b.ts", type: "request-change", summary: "Guard the null case", status: "addressed" },
    { path: "c.ts", type: "request-change", summary: "Drop the dead branch", status: "untouched" },
  ],
  beyondAsks: ["d.ts"],
};

describe("DeltaAccountPanel (#73)", () => {
  it("states each ask's status and surfaces the beyond-asks change loudly", () => {
    const { container } = mount(<DeltaAccountPanel account={account} onAnchor={vi.fn()} />);
    const panel = container.querySelector('[data-testid="delta-account"]');
    expect(panel).not.toBeNull();
    // Two addressed, one untouched — read off the rendered statuses.
    const statuses = [...container.querySelectorAll(".delta-account-status")].map((el) =>
      el.getAttribute("data-status"),
    );
    expect(statuses).toEqual(["addressed", "addressed", "untouched"]);
    // The beyond-asks change is surfaced as a loud alert naming the path.
    const beyond = container.querySelector('[data-testid="delta-account-beyond"]');
    expect(beyond?.getAttribute("role")).toBe("alert");
    expect(beyond?.textContent).toContain("1 change beyond your asks");
    expect(beyond?.textContent).toContain("d.ts");
  });

  it("renders the LLM digest as a headline ABOVE the facts when present (#73/M25)", () => {
    const { container } = mount(
      <DeltaAccountPanel
        account={account}
        onAnchor={vi.fn()}
        digest="Addressed two, left one, and touched a file nobody asked about."
      />,
    );
    const digest = container.querySelector('[data-testid="delta-account-digest"]');
    expect(digest?.textContent).toContain("touched a file nobody asked about");
    // It sits ABOVE the facts: the digest node precedes the asks list in document order.
    const asks = container.querySelector(".delta-account-asks");
    expect(
      digest && asks && digest.compareDocumentPosition(asks) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("MODEL-FREE FLOOR at the UI: with no digest, the facts render in full and no headline appears", () => {
    const { container } = mount(<DeltaAccountPanel account={account} onAnchor={vi.fn()} />);
    // No digest headline…
    expect(container.querySelector('[data-testid="delta-account-digest"]')).toBeNull();
    // …but every fact is present and the beyond-asks alert still surfaces.
    expect(container.querySelectorAll(".delta-account-status")).toHaveLength(3);
    expect(container.querySelector('[data-testid="delta-account-beyond"]')).not.toBeNull();
  });

  it("anchors: activating an item navigates to that path (the moved hunk)", () => {
    const onAnchor = vi.fn();
    const { container } = mount(<DeltaAccountPanel account={account} onAnchor={onAnchor} />);
    // Tapping the untouched ask anchors to its file…
    const items = container.querySelectorAll<HTMLButtonElement>(
      ".delta-account-asks .delta-account-item",
    );
    fireEvent.click(items[2] as HTMLButtonElement);
    expect(onAnchor).toHaveBeenCalledWith("c.ts");
    // …and tapping the beyond-asks change anchors to it too.
    const beyondItem = container.querySelector<HTMLButtonElement>(".delta-account-beyond-item");
    fireEvent.click(beyondItem as HTMLButtonElement);
    expect(onAnchor).toHaveBeenCalledWith("d.ts");
  });

  it("renders nothing when there are no asks and nothing beyond (never an empty shell)", () => {
    const { container } = mount(
      <DeltaAccountPanel account={{ asks: [], beyondAsks: [] }} onAnchor={vi.fn()} />,
    );
    expect(container.querySelector('[data-testid="delta-account"]')).toBeNull();
  });
});
