import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore } from "@rennet/adapters";
import type { RefinementResult, Review } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { reworkHandlers } from "./dispatch/rework";

// B11 cluster 5 (task 5.3) — the living-draft span-rework command. A ONE-SHOT worker
// reworks one staged ask's body, serialized per document, re-anchors the span by quote
// match, and lands the result through the durable ask log (the sole ask writer).

const REVIEW_ID = "review-1";
const REVIEW = {
  id: REVIEW_ID,
  repositoryRoot: "/repo",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", createdAt: "", truncated: false, files: [] }],
  dispositions: [],
  status: "current",
} as unknown as Review;

function harness(reworkSpan?: DispatchDeps["reworkSpan"]) {
  const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-rework-dispatch-")));
  // A staged ask the reviewer will rework — a prose body with a span to revise.
  store.append(REVIEW_ID, {
    kind: "stage",
    ask: { id: "a1", anchor: "src/x.ts:10", type: "comment", body: "the middle paragraph" },
  });
  const rt = createDispatchRuntime({
    askLog: store,
    service: { reviewById: (id: string) => (id === REVIEW_ID ? REVIEW : undefined) },
    ...(reworkSpan ? { reworkSpan } : {}),
  } as unknown as DispatchDeps);
  return { store, reviseSpan: reworkHandlers(rt)["review.reviseSpan"] };
}

const call = (extra: Record<string, unknown> = {}) => ({
  commandId: randomUUID(),
  reviewId: REVIEW_ID,
  askId: "a1",
  span: "the middle paragraph",
  instruction: "make it sharper",
  ...extra,
});

const refined = (text: string): RefinementResult => ({
  status: "refined",
  refined: text,
  model: "test-model",
});

describe("review.reviseSpan (B11 5.1) — one-shot worker, ask-log write, quote carry", () => {
  it("dispatches exactly ONE one-shot worker and lands the result through the ask log", async () => {
    const reworkSpan = vi.fn(async () => refined("a sharper middle paragraph"));
    const { store, reviseSpan } = harness(reworkSpan);

    const out = (await reviseSpan(call())) as { status: string; reworkedBody: string };

    // One fresh turn (never a resident cursor), and the durable ask body is the reworked text.
    expect(reworkSpan).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("reworked");
    expect(out.reworkedBody).toBe("a sharper middle paragraph");
    expect(store.readProjection(REVIEW_ID).stagedAsks.a1?.body).toBe("a sharper middle paragraph");
  });

  it("returns a receipt that reverses the edit (receipt-is-undo)", async () => {
    const reworkSpan = vi.fn(async () => refined("reworked body"));
    const { reviseSpan } = harness(reworkSpan);

    const out = (await reviseSpan(call())) as {
      receipt: { kind: string; id: string; body: string };
    };
    // The inverse of the edit restores the PRIOR body — feeding it back undoes the rework.
    expect(out.receipt).toEqual({ kind: "edit", id: "a1", body: "the middle paragraph" });
  });

  it("re-anchors the reworked span by quote match after regeneration", async () => {
    // The regenerated body MOVED the span to the end; the carry finds its new home.
    const reworkSpan = vi.fn(async () =>
      refined("a new opener\n\ntrailing\n\nthe middle paragraph"),
    );
    const { reviseSpan } = harness(reworkSpan);

    const out = (await reviseSpan(call())) as { carriedAnchor: string | null };
    expect(out.carriedAnchor).toBe("the middle paragraph");
  });

  it("serializes two reworks on ONE document (the second waits for the first)", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reworkSpan = vi.fn(async () => {
      order.push(`start-${reworkSpan.mock.calls.length}`);
      if (reworkSpan.mock.calls.length === 1) await gate;
      order.push(`end-${reworkSpan.mock.calls.length}`);
      return refined("body");
    });
    const { reviseSpan } = harness(reworkSpan);

    const first = reviseSpan(call());
    const second = reviseSpan(call());

    // The second worker has NOT started while the first is still in flight.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start-1"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("answers an honest unavailable when no rework seat is wired", async () => {
    const { reviseSpan } = harness(); // no reworkSpan producer
    const out = (await reviseSpan(call())) as { status: string };
    expect(out.status).toBe("unavailable");
  });

  it("answers unavailable when the ask is no longer staged", async () => {
    const reworkSpan = vi.fn(async () => refined("x"));
    const { reviseSpan } = harness(reworkSpan);
    const out = (await reviseSpan(call({ askId: "gone" }))) as { status: string };
    expect(out.status).toBe("unavailable");
    expect(reworkSpan).not.toHaveBeenCalled();
  });
});
