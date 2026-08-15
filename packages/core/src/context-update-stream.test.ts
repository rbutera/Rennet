import { describe, expect, it } from "vitest";
import { CanvasChangeFeed } from "./canvas-change-feed";
import type { ViewState } from "./canvas-ops";
import {
  buildOrchestratorRequest,
  ContextUpdateStream,
  type DeliveredEvent,
  renderOpenAssembledPrompt,
  ViewingBatcher,
} from "./context-update-stream";

/** A controllable injected clock. */
function clock(start = 0): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (next) => (t = next) };
}

function newStream(now: () => number, windowMs = 250) {
  const batcher = new ViewingBatcher({ now, windowMs });
  return new ContextUpdateStream({ batcher });
}

describe("ContextUpdateStream — user acts", () => {
  it("a user selection appears in the next-turn context and the log", () => {
    const c = clock();
    const stream = newStream(c.now);
    stream.startTurn(); // establish a turn boundary
    stream.push({
      kind: "selected",
      anchor: "app/auth.ts#L10",
      elementSummary: "auth guard",
      seq: 5,
    });
    const context = stream.nextTurnContext();
    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({
      event: "selected",
      anchor: "app/auth.ts#L10",
      seq: 5,
    });
    expect(stream.entries()).toContainEqual(context[0]);
  });

  it("a span-bearing selection carries its anchor and excerpt through delivery unmodified (#79)", () => {
    const stream = newStream(clock().now);
    stream.push({
      kind: "selected",
      anchor: "rennet:occ/x#L2-L5@additions",
      elementSummary: "auth guard",
      excerpt: "const exact = bytes;\nreturn exact;",
      seq: 5,
    });
    expect(stream.entries()).toEqual([
      {
        event: "selected",
        anchor: "rennet:occ/x#L2-L5@additions",
        elementSummary: "auth guard",
        excerpt: "const exact = bytes;\nreturn exact;",
        seq: 5,
      },
    ]);
  });

  it("a proposal dismissal teaches: outcome + edited payload are carried", () => {
    const c = clock();
    const stream = newStream(c.now);
    stream.push({
      kind: "proposal-adjudicated",
      proposalId: "pr_9",
      outcome: "dismissed",
      editedPayload: "reworded to request-change",
      seq: 7,
    });
    expect(stream.entries()[0]).toMatchObject({
      event: "proposal-adjudicated",
      proposalId: "pr_9",
      outcome: "dismissed",
      editedPayload: "reworded to request-change",
    });
  });

  it("point events preserve seq order (coalesce is only for viewing — never reorder)", () => {
    const c = clock();
    const stream = newStream(c.now);
    stream.push({ kind: "selected", anchor: "a", elementSummary: "A", seq: 1 });
    stream.push({ kind: "disposed", anchor: "b", type: "approve", body: "ok", seq: 2 });
    stream.push({ kind: "selected", anchor: "c", elementSummary: "C", seq: 3 });
    expect(stream.entries().map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("R35: a buffered viewing lands BEFORE a later ordered point event (never reorder)", () => {
    const c = clock();
    const stream = newStream(c.now, 250);
    stream.push({ kind: "viewing", canvasId: "cv_1", seq: 1 }); // buffered, not yet due
    stream.push({ kind: "disposed", anchor: "a", type: "approve", body: "ok", seq: 2 }); // ordered
    // The ordered event forced the earlier viewing out FIRST: the merged log is
    // seq-monotonic, not [2, 1].
    expect(stream.entries().map((e) => e.seq)).toEqual([1, 2]);
    expect(stream.entries().map((e) => e.event)).toEqual(["viewing", "disposed"]);
  });

  it("R35: a buffered viewing lands BEFORE a later change-feed event (never reorder)", () => {
    const c = clock();
    const feed = new CanvasChangeFeed();
    const batcher = new ViewingBatcher({ now: c.now, windowMs: 250 });
    const stream = new ContextUpdateStream({ batcher, changeFeed: feed, canvasIds: ["cv_1"] });
    stream.push({ kind: "viewing", canvasId: "cv_2", seq: 1 }); // buffered (a different canvas)
    feed.publish({ reviewId: "rv", canvasId: "cv_1", elementKey: "el", seq: 2 });
    feed.flush();
    expect(stream.entries().map((e) => e.seq)).toEqual([1, 2]);
    expect(stream.entries().map((e) => e.event)).toEqual(["viewing", "changed"]);
    stream.dispose();
  });

  it("does NOT coalesce two viewings of one canvas across an intervening ordered event", () => {
    const c = clock();
    const stream = newStream(c.now, 250);
    stream.push({ kind: "viewing", canvasId: "cv_1", seq: 1 });
    stream.push({ kind: "disposed", anchor: "a", type: "approve", body: "ok", seq: 2 }); // flushes viewing@1
    stream.push({ kind: "viewing", canvasId: "cv_1", seq: 3 }); // a FRESH buffer, not coalesced with @1
    stream.drainViewing();
    const viewings = stream.entries().filter((e) => e.event === "viewing");
    expect(viewings).toHaveLength(2); // NOT one coalesced 1..3 — that would reorder past seq 2
    expect(stream.entries().map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("dispose drains buffered deixis into the log (never silent)", () => {
    const c = clock();
    const feed = new CanvasChangeFeed();
    const batcher = new ViewingBatcher({ now: c.now });
    const stream = new ContextUpdateStream({ batcher, changeFeed: feed, canvasIds: ["cv_1"] });
    stream.push({ kind: "viewing", canvasId: "cv_1", seq: 1 });
    expect(stream.entries()).toHaveLength(0); // buffered, window not elapsed
    stream.dispose();
    expect(stream.entries().filter((e) => e.event === "viewing")).toHaveLength(1); // drained, not lost
  });
});

describe("ContextUpdateStream — request-time view injection (Q5)", () => {
  it("a question asked while on the decisions lens carries that lens context", () => {
    const view: ViewState = {
      openCanvasId: "cv_decisions",
      angle: "decisions",
      expandedCohorts: ["coh_auth"],
      selection: "dec_42",
    };
    const request = buildOrchestratorRequest("does this alter the auth path?", view);
    expect(request.viewContext.angle).toBe("decisions");
    expect(request.viewContext.canvasId).toBe("cv_decisions");
    expect(request.viewContext.selection).toBe("dec_42");
    expect(request.viewContext.expandedCohorts).toEqual(["coh_auth"]);
    expect(request.question).toContain("this");
  });

  it("bundles the pushed next-turn events into the request", () => {
    const c = clock();
    const stream = newStream(c.now);
    stream.push({ kind: "selected", anchor: "x", elementSummary: "X", seq: 1 });
    const view: ViewState = { expandedCohorts: [] };
    const request = buildOrchestratorRequest("what is this?", view, stream.startTurn());
    expect(request.contextEvents).toHaveLength(1);
    expect(request.contextEvents[0]).toMatchObject({ event: "selected", anchor: "x" });
  });

  it("renders a span-bearing selected event into the inspectable request bytes (#79)", () => {
    const stream = newStream(clock().now);
    stream.push({
      kind: "selected",
      anchor: "rennet:occ/x#L2-L5@additions",
      elementSummary: "auth guard",
      excerpt: "const exact = bytes;\nreturn exact;",
      seq: 9,
    });
    const request = buildOrchestratorRequest(
      "is this safe?",
      { expandedCohorts: [] },
      stream.startTurn(),
    );
    const expected = {
      event: "selected" as const,
      anchor: "rennet:occ/x#L2-L5@additions",
      elementSummary: "auth guard",
      excerpt: "const exact = bytes;\nreturn exact;",
      seq: 9,
    };
    expect(request.contextEvents).toEqual([expected]);
    expect(
      renderOpenAssembledPrompt(JSON.stringify(request.viewContext), request.contextEvents),
    ).toContain(`- ${JSON.stringify(expected)}`);
  });

  it("snapshots expandedCohorts — a later mutation of the caller array does not rewrite the request", () => {
    const cohorts = ["coh_a"];
    const request = buildOrchestratorRequest("q", { expandedCohorts: cohorts });
    cohorts.push("coh_b"); // mutate the source array AFTER building the request
    expect(request.viewContext.expandedCohorts).toEqual(["coh_a"]); // snapshot is unaffected
  });
});

describe("ViewingBatcher — hand-rolled deixis batching under an injected clock", () => {
  it("coalesces two viewings of one canvas into one delivery that states its covered range", () => {
    const c = clock(1000);
    const stream = newStream(c.now, 250);
    stream.push({
      kind: "viewing",
      canvasId: "cv_1",
      cohortId: "coh_a",
      angle: "sequence",
      seq: 3,
    });
    stream.push({
      kind: "viewing",
      canvasId: "cv_1",
      cohortId: "coh_b",
      angle: "sequence",
      seq: 6,
    });
    // Before the window elapses: nothing delivered (batched, but NOT dropped).
    stream.flushViewing(1100);
    expect(stream.entries()).toHaveLength(0);
    // After the window: exactly ONE viewing event, stating the covered seq range.
    c.set(1300);
    stream.flushViewing(1300);
    const entries = stream.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "viewing",
      canvasId: "cv_1",
      cohortId: "coh_b", // latest replaces earlier
      covers: { from: 3, to: 6 }, // never silent — states what it covers
    });
  });

  it("distinct canvases each get their own delivery, oldest-first", () => {
    const c = clock(0);
    const batcher = new ViewingBatcher({ now: c.now, windowMs: 100 });
    batcher.push({ canvasId: "cv_a", seq: 1 });
    batcher.push({ canvasId: "cv_b", seq: 4 });
    c.set(200);
    const delivered = batcher.flushDue(200);
    expect(delivered.map((e) => (e.event === "viewing" ? e.canvasId : ""))).toEqual([
      "cv_a",
      "cv_b",
    ]);
  });

  it("the bounded buffer flushes the oldest key rather than dropping it (never silent)", () => {
    const c = clock(0);
    const batcher = new ViewingBatcher({ now: c.now, windowMs: 1000, maxBufferedCanvases: 1 });
    batcher.push({ canvasId: "cv_a", seq: 1 });
    const forced = batcher.push({ canvasId: "cv_b", seq: 2 }); // over the cap
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({
      event: "viewing",
      canvasId: "cv_a",
      covers: { from: 1, to: 1 },
    });
    expect(batcher.pendingCount()).toBe(1); // cv_b remains
  });
});

describe("ContextUpdateStream — change feed consumption (R35, not Rx)", () => {
  it("delivers a change-feed notification as an ordered event carrying its seq range", () => {
    const c = clock();
    const feed = new CanvasChangeFeed();
    const batcher = new ViewingBatcher({ now: c.now });
    const stream = new ContextUpdateStream({ batcher, changeFeed: feed, canvasIds: ["cv_1"] });
    feed.publish({ reviewId: "rv", canvasId: "cv_1", elementKey: "el_7", seq: 11 });
    feed.publish({ reviewId: "rv", canvasId: "cv_1", elementKey: "el_7", seq: 12 });
    feed.flush();
    const changed = stream.entries().filter((e) => e.event === "changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      event: "changed",
      canvasId: "cv_1",
      elementKey: "el_7",
      covers: { from: 11, to: 12 }, // conflated range from the feed
    });
    stream.dispose();
  });
});

describe("renderOpenAssembledPrompt — byte-for-byte inspectable panel", () => {
  it("contains every pushed event verbatim after the primer text", () => {
    const c = clock();
    const stream = newStream(c.now);
    stream.push({ kind: "selected", anchor: "app/auth.ts#L10", elementSummary: "guard", seq: 1 });
    stream.push({
      kind: "disposed",
      anchor: "app/auth.ts#L10",
      type: "request-change",
      body: "narrow it",
      seq: 2,
    });
    const panel = renderOpenAssembledPrompt("PRIMER-TEXT", stream.entries());
    expect(panel.startsWith("PRIMER-TEXT")).toBe(true);
    for (const event of stream.entries() as DeliveredEvent[]) {
      expect(panel).toContain(JSON.stringify(event));
    }
  });
});
