import { describe, expect, it } from "vitest";
import { PipelineStartGuard } from "./pipeline-guard";

/** A controllable start: counts invocations and lets a test settle it on demand. */
function deferredStart<R = string>() {
  let resolve!: (v: R) => void;
  let reject!: (e: unknown) => void;
  let calls = 0;
  const start = () => {
    calls += 1;
    return new Promise<R>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  };
  return {
    start,
    get calls() {
      return calls;
    },
    resolve: (v: R) => resolve(v),
    reject: (e: unknown) => reject(e),
  };
}

describe("PipelineStartGuard — idempotent per session + generation", () => {
  it("starts once for two concurrent entries on the same (session, generation); both share the outcome", async () => {
    const guard = new PipelineStartGuard();
    const d = deferredStart();
    const a = guard.start("s1", "gen1", d.start);
    const b = guard.start("s1", "gen1", d.start); // re-entry mid-generation
    expect(d.calls).toBe(1); // POSITIVE CONTROL: without the guard this would be 2
    d.resolve("boards");
    expect(await a).toBe("boards");
    expect(await b).toBe("boards");
  });

  it("re-entry after the generation resolved returns the memoised start (never re-drafts)", async () => {
    const guard = new PipelineStartGuard();
    const d = deferredStart();
    const a = guard.start("s1", "gen1", d.start);
    d.resolve("boards");
    await a;
    const again = guard.start("s1", "gen1", d.start);
    expect(d.calls).toBe(1); // still one — the resolved generation is not re-run
    expect(await again).toBe("boards");
  });

  it("a new generation is a new key — the successor drafts freely", async () => {
    const guard = new PipelineStartGuard();
    const g1 = deferredStart();
    const g2 = deferredStart();
    guard.start("s1", "gen1", g1.start);
    guard.start("s1", "gen2", g2.start);
    expect(g1.calls).toBe(1);
    expect(g2.calls).toBe(1);
  });

  it("a different session is a different key", () => {
    const guard = new PipelineStartGuard();
    const d = deferredStart();
    guard.start("s1", "gen1", d.start);
    guard.start("s2", "gen1", d.start);
    expect(d.calls).toBe(2);
  });

  it("a failed start drops its key so a fresh entry retries (never wedged)", async () => {
    const guard = new PipelineStartGuard();
    const first = deferredStart();
    const p = guard.start("s1", "gen1", first.start);
    first.reject(new Error("crashed"));
    await expect(p).rejects.toThrow("crashed");
    // Key dropped: a retry re-invokes start rather than replaying the failure.
    const second = deferredStart();
    const retry = guard.start("s1", "gen1", second.start);
    expect(second.calls).toBe(1);
    second.resolve("boards");
    expect(await retry).toBe("boards");
  });
});
