import { describe, expect, it } from "vitest";
import { LiveTurnRegistry } from "./live-turn-registry";

describe("LiveTurnRegistry — scoped reaping on quit (issue #251, criterion 4)", () => {
  it("abortAll fires the signal of every in-flight turn and reports how many it SIGNALLED", () => {
    const registry = new LiveTurnRegistry();
    const a = registry.register("turn-a");
    const b = registry.register("turn-b");
    // Nothing is aborted until quit.
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);

    const outcome = registry.abortAll();

    // Both controllers' signals fire — this is the whole point: on quit, the abort
    // reaches both backends via each controller's signal.
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    // The count is what it SIGNALLED (a request count), never a claim that a child exited.
    expect(outcome).toEqual({ signalled: 2 });
  });

  it("abortReview stops only the named review's turns (the client Stop, #382 M2)", () => {
    const registry = new LiveTurnRegistry();
    const a = registry.register("turn-a", "review-1");
    const b = registry.register("turn-b", "review-1");
    const other = registry.register("turn-c", "review-2");
    const unscoped = registry.register("turn-d");

    const count = registry.abortReview("review-1");

    expect(count).toBe(2);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    // A different review's turn and an unscoped turn are untouched.
    expect(other.signal.aborted).toBe(false);
    expect(unscoped.signal.aborted).toBe(false);
  });

  it("abortReview is idempotent and safe with nothing in flight (a double-tap Stop)", () => {
    const registry = new LiveTurnRegistry();
    registry.register("t", "rev");
    expect(registry.abortReview("rev")).toBe(1);
    // The turn settles (its handler's finally), then a second Stop finds nothing.
    registry.settle("t");
    expect(registry.abortReview("rev")).toBe(0);
    expect(registry.abortReview("never")).toBe(0);
  });

  it("does NOT signal a turn that already SETTLED — the leak guard (a registry that only grew is the bug)", () => {
    const registry = new LiveTurnRegistry();
    const settled = registry.register("done");
    const stillRunning = registry.register("live");
    // The turn finished (completed / errored / aborted) and left the registry.
    registry.settle("done");

    const outcome = registry.abortAll();

    // Only the still-in-flight turn is signalled. If `settle` were a no-op — a registry
    // that only ever grows — the finished turn's controller would be aborted here too,
    // and `signalled` would read 2. That is the literal original bug this guards.
    expect(outcome).toEqual({ signalled: 1 });
    expect(settled.signal.aborted).toBe(false);
    expect(stillRunning.signal.aborted).toBe(true);
  });

  it("tracks exactly the in-flight turns: a settled turn is gone from the active set", () => {
    const registry = new LiveTurnRegistry();
    registry.register("t1");
    registry.register("t2");
    expect(registry.size).toBe(2);
    expect(registry.activeTurnIds()).toEqual(["t1", "t2"]);

    registry.settle("t1");
    expect(registry.size).toBe(1);
    expect(registry.activeTurnIds()).toEqual(["t2"]);
  });

  it("clears the registry after abortAll so a second quit does not re-abort settled work", () => {
    const registry = new LiveTurnRegistry();
    registry.register("t1");
    expect(registry.abortAll()).toEqual({ signalled: 1 });
    // The registry is empty afterwards — a second before-quit (or a stray call) finds
    // nothing to abort rather than firing a stale controller.
    expect(registry.size).toBe(0);
    expect(registry.abortAll()).toEqual({ signalled: 0 });
  });

  it("register returns a DISTINCT controller per turn (one turn's abort never touches another's)", () => {
    const registry = new LiveTurnRegistry();
    const a = registry.register("a");
    const b = registry.register("b");
    expect(a).not.toBe(b);
    a.abort();
    // Aborting one leaves the other's signal untouched.
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it("settling an unknown turn is a harmless no-op", () => {
    const registry = new LiveTurnRegistry();
    registry.register("known");
    expect(() => registry.settle("never-registered")).not.toThrow();
    expect(registry.size).toBe(1);
  });

  it("REJECTS a duplicate live id so Stop on B can never abort A (#382 M2, finding 7)", () => {
    const registry = new LiveTurnRegistry();
    const a = registry.register("dup", "review-a");
    // A second turn reusing an in-flight id is a collision — refused, not silently replaced.
    expect(() => registry.register("dup", "review-b")).toThrow(/already in flight/);
    // A's controller is intact and still the one the registry holds: Stop on review-b touches
    // nothing (B never registered), and A is still reapable.
    expect(registry.abortReview("review-b")).toBe(0);
    expect(a.signal.aborted).toBe(false);
    expect(registry.abortReview("review-a")).toBe(1);
    expect(a.signal.aborted).toBe(true);
    // After the turn settles the id is free for a fresh (sequential) turn — no false collision.
    registry.settle("dup");
    expect(() => registry.register("dup", "review-c")).not.toThrow();
  });

  it("reports a still-streaming turn as real in-flight state, resuming its body (#382 M2, finding 5)", () => {
    const registry = new LiveTurnRegistry();
    registry.register("t1", "rev", { threadId: "th", channel: "orchestrator" });
    registry.appendDelta("t1", "abc");
    registry.appendDelta("t1", "def");
    // A one-shot ask (no stream descriptor) is never reported as in-flight.
    registry.register("oneshot", "rev");

    expect(registry.bodyOf("t1")).toBe("abcdef");
    expect(registry.inFlightFor("rev")).toEqual([
      { threadId: "th", turnId: "t1", channel: "orchestrator", model: "harness", bodySoFar: "abcdef" },
    ]);
    // Another review's live turns are not reported.
    expect(registry.inFlightFor("other")).toEqual([]);
    // Once settled, the turn is no longer in-flight (reattach would fall back to persisted state).
    registry.settle("t1");
    expect(registry.inFlightFor("rev")).toEqual([]);
    expect(registry.bodyOf("t1")).toBe("");
  });
});
