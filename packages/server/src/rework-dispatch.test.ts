import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore } from "@rennet/adapters";
import type { RefinementResult, Review } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { askHandlers } from "./dispatch/ask";
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

// The seeded ask body is LARGER than the span the reviewer revises, so the splice
// (replace the span in place) is observable: the surrounding prose must survive.
const FULL_BODY = "opening line\n\nthe middle paragraph\n\nclosing line";

function harness(reworkSpan?: DispatchDeps["reworkSpan"]) {
  const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-rework-dispatch-")));
  // A staged ask the reviewer will rework — a prose body with a span to revise.
  store.append(REVIEW_ID, {
    kind: "stage",
    ask: { id: "a1", anchor: "src/x.ts:10", type: "comment", body: FULL_BODY },
  });
  const rt = createDispatchRuntime({
    askLog: store,
    service: { reviewById: (id: string) => (id === REVIEW_ID ? REVIEW : undefined) },
    ...(reworkSpan ? { reworkSpan } : {}),
  } as unknown as DispatchDeps);
  return {
    store,
    reviseSpan: reworkHandlers(rt)["review.reviseSpan"],
    editAsk: askHandlers(rt)["ask.edit"],
  };
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
  it("SPLICES the refined span into the full body — surrounding prose survives (finding 5)", async () => {
    const reworkSpan = vi.fn(async () => refined("a sharper middle paragraph"));
    const { store, reviseSpan } = harness(reworkSpan);

    const out = (await reviseSpan(call())) as { status: string; reworkedBody: string };

    // One fresh turn (never a resident cursor). The reworked span replaces ONLY the selected
    // span; "opening line" and "closing line" are untouched — revising one sentence does not
    // delete the document (the whole-body-replacement bug).
    expect(reworkSpan).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("reworked");
    expect(out.reworkedBody).toBe("opening line\n\na sharper middle paragraph\n\nclosing line");
    expect(store.readProjection(REVIEW_ID).stagedAsks.a1?.body).toBe(
      "opening line\n\na sharper middle paragraph\n\nclosing line",
    );
  });

  it("returns a receipt that reverses the edit (receipt-is-undo)", async () => {
    const reworkSpan = vi.fn(async () => refined("reworked span"));
    const { reviseSpan } = harness(reworkSpan);

    const out = (await reviseSpan(call())) as {
      receipt: { kind: string; id: string; body: string };
    };
    // The inverse of the edit restores the PRIOR full body — feeding it back undoes the rework.
    expect(out.receipt).toEqual({ kind: "edit", id: "a1", body: FULL_BODY });
  });

  it("re-anchors the reworked span by quote match after regeneration", async () => {
    // The refined span is the span's new home; the carry finds it in the spliced body.
    const reworkSpan = vi.fn(async () => refined("a sharper middle paragraph"));
    const { reviseSpan } = harness(reworkSpan);

    const out = (await reviseSpan(call())) as { carriedAnchor: string | null };
    expect(out.carriedAnchor).toBe("a sharper middle paragraph");
  });

  it("REPRODUCED RACE (finding 5): a manual ask.edit during the worker is NOT overwritten", async () => {
    // The one-shot worker awaits a gate — the window in which a concurrent `ask.edit` lands.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reworkSpan = vi.fn(async () => {
      await gate;
      return refined("a sharper middle paragraph");
    });
    const { store, reviseSpan, editAsk } = harness(reworkSpan);

    // Start the rework (reads the ask, then blocks on the gate inside the worker).
    const reworkPromise = reviseSpan(call());
    await new Promise((r) => setTimeout(r, 0)); // let the worker reach the gate

    // The reviewer manually edits the SAME ask while the worker is in flight.
    await editAsk({ sessionId: REVIEW_ID, id: "a1", body: "MY MANUAL EDIT — keep this" });

    // Release the worker; its result is derived from the STALE pre-edit body.
    release();
    const out = (await reworkPromise) as { status: string; reason?: string };

    // The stale rework is DISCARDED, not silently applied over the manual edit (honest CAS).
    expect(out.status).toBe("unavailable");
    expect(out.reason).toMatch(/changed while the rework/i);
    // The manual edit stands — the lost-update is gone.
    expect(store.readProjection(REVIEW_ID).stagedAsks.a1?.body).toBe("MY MANUAL EDIT — keep this");
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
