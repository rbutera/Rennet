// @vitest-environment happy-dom
//
// Mounted coverage for the SymbolInspector (Rai, wireframes #8): the pending line,
// the honest unavailable vs empty states, the definition/reference sites, and the
// open-in-editor + close interactions.
import type { SymbolInspection } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { SymbolInspector } from "./symbol-inspector";

const OK_INSPECTION: SymbolInspection = {
  name: "makeThing",
  definition: {
    status: "ok",
    sites: [
      { path: "packages/core/src/thing.ts", line: 12, kind: "function", scope: "@rennet/core" },
    ],
  },
  references: {
    status: "ok",
    sites: [
      { path: "packages/ui/src/use-thing.ts", line: 4, scope: "@rennet/ui" },
      { path: "packages/ui/src/use-thing.ts", line: 9, scope: "@rennet/ui" },
    ],
  },
};

describe("SymbolInspector", () => {
  it("shows a pending line while the lookup is in flight", () => {
    const { container } = mount(<SymbolInspector name="makeThing" pending onClose={vi.fn()} />);
    expect(container.querySelector(".symbol-pending")?.textContent).toContain("makeThing");
  });

  it("renders definition + reference sites, and opens a site in the editor on click", () => {
    const onOpenInEditor = vi.fn();
    const { container } = mount(
      <SymbolInspector
        name="makeThing"
        inspection={OK_INSPECTION}
        onOpenInEditor={onOpenInEditor}
        onClose={vi.fn()}
      />,
    );
    // The definition site is present and openable.
    const defSite = container.querySelector<HTMLButtonElement>(
      '[data-section="definition"] .symbol-site-open',
    );
    if (!defSite) throw new Error("definition site did not mount");
    expect(defSite.textContent).toBe("thing.ts:12");
    fireEvent.click(defSite);
    expect(onOpenInEditor).toHaveBeenCalledWith("packages/core/src/thing.ts", 12);

    // The two references in one file are grouped into a single file row, two lines.
    const groups = container.querySelectorAll('[data-section="references"] .symbol-ref-group');
    expect(groups).toHaveLength(1);
    const lineButtons = groups[0]?.querySelectorAll(".symbol-site-open");
    expect(lineButtons).toHaveLength(2);
  });

  it("keeps unavailable distinct from empty for definitions", () => {
    const unavailable: SymbolInspection = {
      name: "x",
      definition: { status: "unavailable", reason: "the snapshot is stale" },
      references: { status: "ok", sites: [] },
    };
    const { container } = mount(
      <SymbolInspector name="x" inspection={unavailable} onClose={vi.fn()} />,
    );
    expect(
      container.querySelector('[data-section="definition"] .symbol-unavailable'),
    ).not.toBeNull();
    // References ran clean: the empty state, NOT unavailable.
    expect(container.querySelector('[data-section="references"] .symbol-empty')).not.toBeNull();
    expect(container.querySelector('[data-section="references"] .symbol-unavailable')).toBeNull();
  });

  it("fires onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    const { container } = mount(
      <SymbolInspector name="x" inspection={OK_INSPECTION} onClose={onClose} />,
    );
    const close = container.querySelector<HTMLButtonElement>(".symbol-inspector-close");
    if (!close) throw new Error("close button did not mount");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
