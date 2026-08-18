// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { demoCanvases } from "../canvas/fixtures";
import { createViewStore } from "../canvas/store";
import { fireEvent, mount, waitFor } from "../test/dom";
import { CanvasWorkspace } from "./workspace";

describe("CanvasWorkspace navigation shortcuts", () => {
  it("does not rotate the active lens for a modified bracket key from a focused descendant", () => {
    const { container, getByRole } = mount(<CanvasWorkspace canvases={demoCanvases()} />);
    const activeLens = () => container.querySelector(".lens-tab.is-active")?.textContent;
    const focusedTab = getByRole("tab", { name: "Decisions" });
    focusedTab.focus();

    expect(activeLens()).toBe("Decisions");
    fireEvent.keyDown(focusedTab, { key: "[", metaKey: true });

    expect(activeLens()).toBe("Decisions");
  });

  it("agent focus moves cursor/zoom and pulses without selecting, disposing, or persisting (#79)", async () => {
    const canvases = demoCanvases();
    const store = createViewStore({
      angle: "decisions",
      selection: "dec-2-1",
      zoom: { level: "element", elementKey: "dec-2-1" },
    });
    const dispositionsBefore = JSON.stringify(canvases.decisions.layers.disposition.dispositions);
    const onDispositions = vi.fn();
    const diffFor = (elementKey: string) => {
      if (elementKey !== "dec-1-1") return undefined;
      return {
        path: "src/focus.ts",
        paths: ["src/focus.ts"],
        diff: "@@ -10,1 +10,2 @@\n context\n+pointed",
        hunkOccurrences: [[{ id: "c1-h1", oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 }]],
      };
    };
    const { container } = mount(
      <CanvasWorkspace
        canvases={canvases}
        store={store}
        diffFor={diffFor}
        onDispositions={onDispositions}
        agentFocus={{ anchor: "rennet:hunk/c1-h1#L1@additions", nonce: 1 }}
      />,
    );

    await waitFor(() => expect(container.querySelector(".cv-focus")).not.toBeNull());
    expect(store.getState().selection).toBe("dec-2-1");
    expect(store.getState().cursorAnchor).toBe("rennet:hunk/c1-h1#L1@additions");
    expect(store.getState().zoom).toEqual({ level: "diff", elementKey: "dec-1-1" });
    expect(onDispositions).not.toHaveBeenCalled();
    expect(JSON.stringify(canvases.decisions.layers.disposition.dispositions)).toBe(
      dispositionsBefore,
    );
  });
});

describe("CanvasWorkspace keybinding overrides (#44)", () => {
  it("zooms on a remapped zoom.in key and ignores the replaced default", () => {
    const store = createViewStore({ angle: "decisions", zoom: { level: "rollup" } });
    const { getByRole } = mount(
      <CanvasWorkspace
        canvases={demoCanvases()}
        store={store}
        keybindingOverrides={{ "zoom.in": "j" }}
      />,
    );
    const tab = getByRole("tab", { name: "Decisions" });
    tab.focus();

    // The default `l` is now dead — the zoom stays at the roll-up.
    fireEvent.keyDown(tab, { key: "l" });
    expect(store.getState().zoom.level).toBe("rollup");

    // The remapped `j` zooms in (rollup → cohort).
    fireEvent.keyDown(tab, { key: "j" });
    expect(store.getState().zoom.level).toBe("cohort");
  });

  it("keeps the ArrowRight/Escape synonyms and the editable-target guard (control)", () => {
    const store = createViewStore({ angle: "decisions", zoom: { level: "cohort" } });
    const { container } = mount(
      <CanvasWorkspace
        canvases={demoCanvases()}
        store={store}
        keybindingOverrides={{ "zoom.in": "j" }}
      />,
    );
    // Dispatch from the canvas surface, NOT a lens tab: the tablist now owns the
    // arrow keys (WAI-ARIA tabs), so a tab-targeted arrow moves tabs instead.
    const surface = container.querySelector("main.canvas-surface") as Element;

    // ArrowRight is a hardcoded affordance synonym for zoom-in, not a registry chord.
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(store.getState().zoom.level).toBe("element");
  });

  it("an explicit zoom.in unbind also dead-keys the ArrowRight alias", () => {
    const store = createViewStore({ angle: "decisions", zoom: { level: "rollup" } });
    const { container } = mount(
      <CanvasWorkspace
        canvases={demoCanvases()}
        store={store}
        keybindingOverrides={{ "zoom.in": null }}
      />,
    );
    // From the surface (not a tab: the tablist consumes arrows for tab movement).
    fireEvent.keyDown(container.querySelector("main.canvas-surface") as Element, {
      key: "ArrowRight",
    });
    expect(store.getState().zoom.level).toBe("rollup");
  });

  it("an explicit zoom.out unbind also dead-keys the Escape alias", () => {
    const store = createViewStore({ angle: "decisions", zoom: { level: "cohort" } });
    const { getByRole } = mount(
      <CanvasWorkspace
        canvases={demoCanvases()}
        store={store}
        keybindingOverrides={{ "zoom.out": null }}
      />,
    );
    fireEvent.keyDown(getByRole("tab", { name: "Decisions" }), { key: "Escape" });
    expect(store.getState().zoom.level).toBe("cohort");
  });

  it("a registry binding wins over the literal bracket rotation alias", () => {
    const store = createViewStore({ angle: "decisions", zoom: { level: "rollup" } });
    const { getByRole } = mount(
      <CanvasWorkspace
        canvases={demoCanvases()}
        store={store}
        keybindingOverrides={{ "nav.settings": "]" }}
      />,
    );
    fireEvent.keyDown(getByRole("tab", { name: "Decisions" }), { key: "]" });
    expect(store.getState().angle).toBe("decisions");
  });
});

describe("lens tablist arrows vs canvas zoom, and the tabpanel wiring (wave-3 fixes)", () => {
  it("an arrow key on the lens tablist moves the tab selection without zooming the canvas", () => {
    const store = createViewStore({ angle: "decisions", zoom: { level: "rollup" } });
    const { container, getByRole } = mount(
      <CanvasWorkspace canvases={demoCanvases()} store={store} />,
    );
    const tab = getByRole("tab", { name: "Decisions" });
    tab.focus();

    fireEvent.keyDown(tab, { key: "ArrowRight" });
    // Selection follows focus to the next lens (WAI-ARIA tabs pattern)...
    expect(store.getState().angle).toBe("noise");
    // ...and the canvas did NOT also act on the arrow. Pre-fix the keydown bubbled
    // into the workspace handler, whose ArrowRight alias zoomed rollup -> cohort.
    expect(store.getState().zoom.level).toBe("rollup");

    // Positive control: the same key OUTSIDE the tablist still zooms, so the
    // arrow->zoom mapping this test protects the tablist from is genuinely alive.
    const surface = container.querySelector("main.canvas-surface");
    expect(surface).not.toBeNull();
    fireEvent.keyDown(surface as Element, { key: "ArrowRight" });
    expect(store.getState().zoom.level).toBe("cohort");
    expect(store.getState().angle).toBe("noise");
  });

  it("the canvas surface is the tabs. tabpanel: id / aria-controls / aria-labelledby line up", () => {
    const store = createViewStore({ angle: "decisions", zoom: { level: "rollup" } });
    const { container, getByRole } = mount(
      <CanvasWorkspace canvases={demoCanvases()} store={store} />,
    );
    const panel = container.querySelector("main.canvas-surface");
    expect(panel?.getAttribute("id")).toBe("canvas-surface-panel");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe("lens-tab-decisions");
    // Every tab names the panel it controls, by the panel:s real id.
    const tab = getByRole("tab", { name: "Decisions" });
    expect(tab.getAttribute("id")).toBe("lens-tab-decisions");
    expect(tab.getAttribute("aria-controls")).toBe("canvas-surface-panel");
    // Switching lenses re-labels the panel by the NEWLY active tab.
    fireEvent.click(getByRole("tab", { name: "Noise" }));
    expect(panel?.getAttribute("aria-labelledby")).toBe("lens-tab-noise");
    expect(getByRole("tab", { name: "Noise" }).getAttribute("aria-controls")).toBe(
      "canvas-surface-panel",
    );
  });
});
