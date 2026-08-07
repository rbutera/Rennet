import { describe, expect, it } from "vitest";
import { createViewStore } from "./store";

describe("view store — ephemeral navigation state, no read state", () => {
  it("rotating the lens keeps the cursor hunk fixed", () => {
    const store = createViewStore({ angle: "spec", cursorAnchor: "rennet:hunk/h2" });
    store.getState().rotate(1);
    expect(store.getState().angle).toBe("sequence");
    // The fixed point: the cursor anchor survives the rotation untouched.
    expect(store.getState().cursorAnchor).toBe("rennet:hunk/h2");
  });

  it("expand/collapse is navigation only and carries no read state", () => {
    const store = createViewStore();
    store.getState().toggleCohort("cohort:c1");
    expect(store.getState().expandedCohorts["cohort:c1"]).toBe(true);
    store.getState().collapseAll();
    expect(store.getState().expandedCohorts).toEqual({});
    // The view state has no field that could mark content read — structural proof
    // that collapsing never touches coverage.
    expect("read" in store.getState()).toBe(false);
    expect("dispositions" in store.getState()).toBe(false);
  });

  it("toggles the amber overlay and the colour scheme", () => {
    const store = createViewStore();
    expect(store.getState().overlayOn).toBe(false);
    store.getState().toggleOverlay();
    expect(store.getState().overlayOn).toBe(true);
    store.getState().setScheme("light");
    expect(store.getState().scheme).toBe("light");
  });
});
