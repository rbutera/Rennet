import type { RefinementResult } from "@rennet/core";
import type { Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { LiveRefineInput } from "../refine-comment-live";
import { ReworkQueue, type ReworkQueueDeps } from "./rework-queue";

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A rework request for `boardId`. The refine port is injected and ignores the
 *  Review body, so a minimal cast input keeps the fixtures small. `raw` is distinct
 *  per request so a test can prove each submit runs its OWN fresh one-shot turn. */
function req(boardId: string, raw = "note"): { boardId: string; input: LiveRefineInput } {
  return { boardId, input: { review: {} as Review, type: "comment", raw } };
}

const REFINED: RefinementResult = { status: "refined", refined: "clean", model: "m" };

/** A fake apply spy — the sanctioned board writer. Records every write and returns
 *  the enriched-batch shape `WhiteboardClient.apply` produces. */
function applySpy() {
  const calls: { boardId: string; ops: readonly unknown[]; actor: string }[] = [];
  const apply: ReworkQueueDeps["whiteboard"]["apply"] = (boardId, ops, actor) => {
    calls.push({ boardId, ops, actor });
    return Promise.resolve({ response: { ok: true }, ops: ops as never });
  };
  return { calls, apply };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ReworkQueue: one-shot workers, serialized per document (task 4.2)", () => {
  it("serializes two reworks for one document — the second starts only after the first commits", async () => {
    const order: string[] = [];
    const write = applySpy();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let call = 0;
    const queue = new ReworkQueue({
      refine: async () => {
        call += 1;
        const n = call;
        order.push(`refine-start-${n}`);
        // Only the first worker blocks; the second runs freely once it starts.
        if (n === 1) await firstGate;
        return REFINED;
      },
      whiteboard: {
        apply: (boardId, ops, actor) => {
          order.push("apply");
          return write.apply(boardId, ops, actor);
        },
      },
      toOps: () => [{ op: "create", element: { id: "e", kind: "note", data: {} } } as never],
      actor: "rework",
    });

    const p1 = queue.submit(req("board-1", "a"));
    const p2 = queue.submit(req("board-1", "b"));

    // Flush microtasks: the second worker must not start while the first is held —
    // and its refine only fires after the first's WRITE commits.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["refine-start-1"]);

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["refine-start-1", "apply", "refine-start-2", "apply"]);
  });

  it("does not serialize reworks across different documents", async () => {
    const started: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });
    const queue = new ReworkQueue({
      refine: async (input) => {
        started.push(input.raw);
        if (input.raw === "a") await aGate;
        return REFINED;
      },
      whiteboard: applySpy(),
      toOps: () => [],
      actor: "rework",
    });

    const pa = queue.submit(req("board-a", "a"));
    const pb = queue.submit(req("board-b", "b"));
    await Promise.resolve();
    await Promise.resolve();
    // B ran even though A is still held — different documents overlap.
    expect(started).toEqual(["a", "b"]);
    releaseA();
    await Promise.all([pa, pb]);
  });

  it("keeps the queue alive after a failed worker (a throw does not wedge the document)", async () => {
    let call = 0;
    const queue = new ReworkQueue({
      refine: async () => {
        call += 1;
        if (call === 1) throw new Error("boom");
        return REFINED;
      },
      whiteboard: applySpy(),
      toOps: () => [],
      actor: "rework",
    });

    await expect(queue.submit(req("board-1"))).rejects.toThrow("boom");
    // The next rework for the same document still runs — the tail swallowed it.
    const { result } = await queue.submit(req("board-1"));
    expect(result.status).toBe("refined");
  });

  it("runs each rework as a fresh one-shot turn — no cursor carried between requests", async () => {
    // One-shot BY CONSTRUCTION: the queue takes a refine port (a fresh turn per call),
    // never a SessionTurnLoop, so there is no harness cursor to resume. Each submit
    // invokes refine exactly once with its own input — proven by distinct `raw`.
    const seen: string[] = [];
    const queue = new ReworkQueue({
      refine: async (input) => {
        seen.push(input.raw);
        return REFINED;
      },
      whiteboard: applySpy(),
      toOps: () => [],
      actor: "rework",
    });
    await queue.submit(req("board-1", "first"));
    await queue.submit(req("board-1", "second"));
    expect(seen).toEqual(["first", "second"]);
  });

  it("lands the write through the sanctioned board client, attributed to the actor", async () => {
    const write = applySpy();
    const ops = [{ op: "create", element: { id: "e", kind: "note", data: {} } } as never];
    const queue = new ReworkQueue({
      refine: async () => REFINED,
      whiteboard: write,
      toOps: (boardId) => (boardId === "board-1" ? ops : []),
      actor: "rework-worker",
    });

    const { applied } = await queue.submit(req("board-1"));
    expect(write.calls).toEqual([{ boardId: "board-1", ops, actor: "rework-worker" }]);
    expect(applied).toBeDefined();
  });

  it("does not write when the rework produces no ops (a no-change result stays off the board)", async () => {
    const write = applySpy();
    const queue = new ReworkQueue({
      refine: async () => ({ status: "no-change", model: "m" }) satisfies RefinementResult,
      whiteboard: write,
      toOps: () => [], // no-change ⇒ nothing to land
      actor: "rework",
    });

    const { applied, result } = await queue.submit(req("board-1"));
    expect(write.calls).toEqual([]);
    expect(applied).toBeUndefined();
    expect(result.status).toBe("no-change");
  });
});
