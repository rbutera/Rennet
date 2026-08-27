import { describe, expect, it, vi } from "vitest";
import { createCoachRegistry } from "./registry";

// The pure anchor registry. The hook-level S8 regression (a duplicated
// `useCoachAnchor` rendered) is Cluster 5's; this covers the factory the hook
// sits on — the duplicate guard and the remount-ordering guard.

const elA = { id: "a" } as unknown as Element;
const elB = { id: "b" } as unknown as Element;

describe("createCoachRegistry", () => {
  it("registers and reads back an element by MarkId", () => {
    const r = createCoachRegistry();
    r.register("new-chat", elA);
    expect(r.get("new-chat")).toBe(elA);
    expect(r.get("lenses")).toBeNull();
  });

  it("throws when a second live element claims the same MarkId (S8 guard)", () => {
    const r = createCoachRegistry();
    r.register("new-chat", elA);
    expect(() => r.register("new-chat", elB)).toThrow(/already registered/);
  });

  it("re-registering the same element is idempotent, not a duplicate", () => {
    const r = createCoachRegistry();
    r.register("fab", elA);
    expect(() => r.register("fab", elA)).not.toThrow();
    expect(r.get("fab")).toBe(elA);
  });

  it("unregister clears only when the caller still owns the id", () => {
    const r = createCoachRegistry();
    r.register("draft", elA);
    // A stale cleanup for elA after elB took over must not wipe elB.
    r.get("draft"); // elA owns it
    r.unregister("draft", elB); // not the owner — no-op
    expect(r.get("draft")).toBe(elA);
    r.unregister("draft", elA); // the owner — clears
    expect(r.get("draft")).toBeNull();
  });

  it("notifies subscribers on register and unregister", () => {
    const r = createCoachRegistry();
    const listener = vi.fn();
    const unsub = r.subscribe(listener);
    r.register("verdict", elA);
    r.unregister("verdict", elA);
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    r.register("verdict", elB);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
