import { describe, expect, it } from "vitest";
import { createRennetStore } from "../store";
import { selectDeltaViewed } from "./viewed-delta";

describe("viewedDelta slice — the delta-mark UI axis", () => {
  it("a section starts unviewed and marks viewed on interaction", () => {
    const store = createRennetStore();
    expect(selectDeltaViewed("sec-a")(store.getState())).toBe(false);
    store.getState().viewedDeltaActions.markDeltaViewed("sec-a");
    expect(selectDeltaViewed("sec-a")(store.getState())).toBe(true);
  });

  it("marks are per-section — viewing one leaves the others unread", () => {
    const store = createRennetStore();
    store.getState().viewedDeltaActions.markDeltaViewed("sec-a");
    expect(selectDeltaViewed("sec-a")(store.getState())).toBe(true);
    expect(selectDeltaViewed("sec-b")(store.getState())).toBe(false);
  });

  it("marking is idempotent and does not mutate the slice reference on a repeat", () => {
    const store = createRennetStore();
    store.getState().viewedDeltaActions.markDeltaViewed("sec-a");
    const after = store.getState().viewedDelta;
    store.getState().viewedDeltaActions.markDeltaViewed("sec-a");
    // A repeat mark is a no-op: same viewed set, stable reference (no needless re-render).
    expect(store.getState().viewedDelta).toBe(after);
    expect(selectDeltaViewed("sec-a")(store.getState())).toBe(true);
  });

  it("is UI-only: a fresh store starts with every delta unread (nothing rehydrated)", () => {
    const first = createRennetStore();
    first.getState().viewedDeltaActions.markDeltaViewed("sec-a");
    const second = createRennetStore();
    expect(selectDeltaViewed("sec-a")(second.getState())).toBe(false);
    expect(second.getState().viewedDelta.viewedDeltaSections).toEqual({});
  });
});
