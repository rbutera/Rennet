import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CoachSnapshot, createCoachStore } from "./store";

function make(initial: CoachSnapshot = { seen: [], skipAll: false }, chainDelayMs = 600) {
  const persisted: CoachSnapshot[] = [];
  const store = createCoachStore({ initial, persist: (s) => persisted.push(s), chainDelayMs });
  return { store, persisted, get: store.getState };
}

describe("coach store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe("election", () => {
    it("elects the first unseen registered mark in system order, regardless of register order", () => {
      const { store } = make();
      store.getState().register("new-chat");
      expect(store.getState().active).toBe("new-chat");
      // start-review is earlier in system order (#487) — it wins once registered.
      store.getState().register("start-review");
      expect(store.getState().active).toBe("start-review");
    });

    it("shows only one mark at a time", () => {
      const { store } = make();
      store.getState().register("smart-list");
      store.getState().register("lenses");
      store.getState().register("fab");
      expect(store.getState().active).toBe("smart-list");
    });

    it("honors an initial seen snapshot — a seen mark never elects", () => {
      const { store } = make({ seen: ["start-review"], skipAll: false });
      store.getState().register("start-review");
      store.getState().register("new-chat");
      expect(store.getState().active).toBe("new-chat");
    });

    it("elects nothing when the initial snapshot is skipAll", () => {
      const { store } = make({ seen: [], skipAll: true });
      store.getState().register("start-review");
      expect(store.getState().active).toBeNull();
    });

    it("unregister drops a mark from the running", () => {
      const { store } = make();
      store.getState().register("start-review");
      store.getState().register("new-chat");
      expect(store.getState().active).toBe("start-review");
      store.getState().unregister("start-review");
      expect(store.getState().active).toBe("new-chat");
    });
  });

  describe("dismiss + chain", () => {
    it("dismiss marks seen, suppresses the next mark for the chain gap, then elects it", () => {
      const { store, persisted } = make();
      store.getState().register("start-review");
      store.getState().register("new-chat");
      store.getState().dismiss("start-review");

      // Gap open: nothing shows yet.
      expect(store.getState().active).toBeNull();
      expect(store.getState().seen["start-review"]).toBe(true);
      expect(persisted.at(-1)).toEqual({ seen: ["start-review"], skipAll: false });

      vi.advanceTimersByTime(600);
      expect(store.getState().active).toBe("new-chat");
    });

    it("dismiss on an already-seen mark is a no-op — no double persist", () => {
      const { store, persisted } = make();
      store.getState().register("start-review");
      store.getState().dismiss("start-review");
      const count = persisted.length;
      store.getState().dismiss("start-review");
      expect(persisted.length).toBe(count);
    });

    it("a surface mounting mid-gap does not jump the queue", () => {
      const { store } = make();
      store.getState().register("start-review");
      store.getState().register("new-chat");
      store.getState().dismiss("start-review");
      // A later surface mounts while the gap is open.
      store.getState().register("smart-list");
      // Still inside the gap — held, nothing shows.
      expect(store.getState().active).toBeNull();
      // Gap closes: system order wins, not mount order — new-chat over smart-list.
      vi.advanceTimersByTime(600);
      expect(store.getState().active).toBe("new-chat");
    });
  });

  describe("skip", () => {
    it("skipEverything clears the active mark, persists skipAll, and blocks future election", () => {
      const { store, persisted } = make();
      store.getState().register("start-review");
      store.getState().skipEverything();
      expect(store.getState().active).toBeNull();
      expect(store.getState().skipAll).toBe(true);
      expect(persisted.at(-1)).toEqual({ seen: [], skipAll: true });
      store.getState().register("new-chat");
      expect(store.getState().active).toBeNull();
    });

    it("skipEverything cancels a pending chain gap", () => {
      const { store } = make();
      store.getState().register("start-review");
      store.getState().register("new-chat");
      store.getState().dismiss("start-review");
      store.getState().skipEverything();
      vi.advanceTimersByTime(600);
      expect(store.getState().active).toBeNull();
    });
  });

  describe("replay", () => {
    it("re-arms every mark and persists a clean snapshot", () => {
      const { store, persisted } = make({ seen: ["start-review", "new-chat"], skipAll: true });
      store.getState().register("start-review");
      store.getState().register("new-chat");
      expect(store.getState().active).toBeNull();

      store.getState().replay();
      expect(store.getState().skipAll).toBe(false);
      expect(store.getState().seen).toEqual({});
      expect(store.getState().active).toBe("start-review");
      expect(persisted.at(-1)).toEqual({ seen: [], skipAll: false });
    });
  });
});
