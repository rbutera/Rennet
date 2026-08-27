import { describe, expect, it } from "vitest";
import { createRennetStore } from "../store";
import { selectDeltaViewed } from "./viewed-delta";

const BOARD = "design-gen1";

describe("viewedDelta slice — the delta-mark UI axis", () => {
  it("a section starts unviewed and marks viewed on interaction", () => {
    const store = createRennetStore();
    expect(selectDeltaViewed(BOARD, "sec-a")(store.getState())).toBe(false);
    store.getState().viewedDeltaActions.markDeltaViewed(BOARD, "sec-a");
    expect(selectDeltaViewed(BOARD, "sec-a")(store.getState())).toBe(true);
  });

  it("marks are per-section — viewing one leaves the others unread", () => {
    const store = createRennetStore();
    store.getState().viewedDeltaActions.markDeltaViewed(BOARD, "sec-a");
    expect(selectDeltaViewed(BOARD, "sec-a")(store.getState())).toBe(true);
    expect(selectDeltaViewed(BOARD, "sec-b")(store.getState())).toBe(false);
  });

  it("marks are per-BOARD — the same ref reworked next generation starts unviewed (finding 3)", () => {
    // `change` reappears each generation; viewing it in design-gen1 must NOT carry into
    // design-gen2's same-ref reworked section. Bare-ref keying regressed exactly here.
    const store = createRennetStore();
    store.getState().viewedDeltaActions.markDeltaViewed("design-gen1", "change");
    expect(selectDeltaViewed("design-gen1", "change")(store.getState())).toBe(true);
    expect(selectDeltaViewed("design-gen2", "change")(store.getState())).toBe(false);
  });

  it("marking is idempotent and does not mutate the slice reference on a repeat", () => {
    const store = createRennetStore();
    store.getState().viewedDeltaActions.markDeltaViewed(BOARD, "sec-a");
    const after = store.getState().viewedDelta;
    store.getState().viewedDeltaActions.markDeltaViewed(BOARD, "sec-a");
    // A repeat mark is a no-op: same viewed set, stable reference (no needless re-render).
    expect(store.getState().viewedDelta).toBe(after);
    expect(selectDeltaViewed(BOARD, "sec-a")(store.getState())).toBe(true);
  });

  it("is UI-only: a fresh store starts with every delta unread (nothing rehydrated)", () => {
    const first = createRennetStore();
    first.getState().viewedDeltaActions.markDeltaViewed(BOARD, "sec-a");
    const second = createRennetStore();
    expect(selectDeltaViewed(BOARD, "sec-a")(second.getState())).toBe(false);
    expect(second.getState().viewedDelta.viewedDeltaSections).toEqual({});
  });
});
