// @vitest-environment happy-dom
//
// The delta re-review account panel (issue #73): it renders the deterministic account
// at the top of a successor review — what moved per ask + what changed beyond the asks
// — and each item anchors (navigates the diff to that path). It gates nothing.
import type { DeltaAccount } from "@rennet/protocol";
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

// ── Hunk grain + handoff attribution (#73 wave 3) ────────────────────────────
const hunkAccount: DeltaAccount = {
  asks: [
    {
      path: "a.ts",
      span: { startLine: 10, endLine: 11 },
      side: "additions",
      type: "request-change",
      summary: "Fix the loop bound",
      status: "partially-addressed",
      handoffTask: { index: 1, title: "Tighten the parser" },
    },
  ],
  beyondAsks: [],
  beyondAskHunks: [
    {
      path: "a.ts",
      span: { startLine: 40, endLine: 42 },
      bucket: "asked-file",
      excerpt: "+  const extra = compute();",
    },
    {
      path: "d.ts",
      span: { startLine: 5 },
      side: "deletions",
      bucket: "unasked-file",
      excerpt: "-gone",
    },
  ],
};

describe("DeltaAccountPanel — hunk grain + attribution (#73 wave 3)", () => {
  it("renders beyond-ask hunk rows with bucket labels", () => {
    const { container } = mount(<DeltaAccountPanel account={hunkAccount} onAnchor={vi.fn()} />);
    const rows = container.querySelectorAll('[data-testid="delta-account-hunk"]');
    expect(rows).toHaveLength(2);
    const buckets = [...rows].map((row) => row.getAttribute("data-bucket"));
    expect(buckets).toContain("asked-file");
    expect(buckets).toContain("unasked-file");
    // The asked-file hunk names its line range (the case path grain cannot see).
    const asked = [...rows].find((row) => row.getAttribute("data-bucket") === "asked-file");
    expect(asked?.textContent).toContain("a.ts");
    expect(asked?.textContent).toContain("40");
  });

  it("activating a hunk row navigates to the hunk's SPAN, not just its path", () => {
    const onAnchor = vi.fn();
    const { container } = mount(<DeltaAccountPanel account={hunkAccount} onAnchor={onAnchor} />);
    const askedRow = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="delta-account-hunk"] button, button[data-testid="delta-account-hunk"]',
      ),
    ].find((el) => el.textContent?.includes("40"));
    fireEvent.click(askedRow as HTMLButtonElement);
    expect(onAnchor).toHaveBeenCalledWith("a.ts", { startLine: 40, endLine: 42 }, undefined);
  });

  it("renders the composed task attribution on an ask when present", () => {
    const { container } = mount(<DeltaAccountPanel account={hunkAccount} onAnchor={vi.fn()} />);
    expect(container.textContent).toContain("Tighten the parser");
  });

  it("LEGACY account (no hunk fields) renders today's path-grain view unchanged", () => {
    const { container } = mount(<DeltaAccountPanel account={account} onAnchor={vi.fn()} />);
    // No hunk rows on a legacy account.
    expect(container.querySelectorAll('[data-testid="delta-account-hunk"]')).toHaveLength(0);
    // The path-grain beyond alert still renders.
    expect(container.querySelector('[data-testid="delta-account-beyond"]')).not.toBeNull();
  });
});
