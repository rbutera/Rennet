import { describe, expect, it } from "vitest";
import {
  conversationAnchorSchema,
  inFlightTurnSchema,
  parseCommandInput,
  parseCommandOutput,
  persistedThreadSchema,
  projectProcessEventSchema,
  reattachResultSchema,
  reviewAskStreamEventSchema,
} from "./index";

/** A valid commandId (the registry's commandId schema is `z.uuid()`). */
const UUID = "00000000-0000-0000-0000-000000000000";

// ─────────────────────────────────────────────────────────────────────────────
// Issue #251 — the streamed review.ask contract + persisted-thread wire shapes.
// The streaming half is only observable in the failure case, so these prove the
// SHAPE holds: an event binds to its exact turn, a stray delta is droppable, and
// the ask-stream discriminator can never collide with project.process's own "done".
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewAskStreamEvent round-trips each variant (#251)", () => {
  it("ask-delta carries thread, turn, channel, and the token delta", () => {
    const event = {
      kind: "ask-delta" as const,
      threadId: "th",
      turnId: "tn",
      channel: "orchestrator" as const,
      delta: "Hel",
    };
    expect(reviewAskStreamEventSchema.parse(event)).toEqual(event);
  });

  it("ask-complete carries the model label and the final body", () => {
    const event = {
      kind: "ask-complete" as const,
      threadId: "th",
      turnId: "tn",
      channel: "codex" as const,
      model: "codex",
      finalBody: "the whole answer",
    };
    expect(reviewAskStreamEventSchema.parse(event)).toEqual(event);
  });

  it("ask-interrupted needs no body — an interrupted turn has no answer to carry", () => {
    const event = {
      kind: "ask-interrupted" as const,
      threadId: "th",
      turnId: "tn",
      channel: "orchestrator" as const,
    };
    expect(reviewAskStreamEventSchema.parse(event)).toEqual(event);
  });
});

describe("a stream event must bind to its exact turn (#251)", () => {
  it("an ask-delta with NO turnId is rejected (a stray delta is droppable, never applied)", () => {
    // RED-proof: make turnId optional on the ask-delta variant and this passes — then a
    // delta from a superseded turn could cross-write a live message with no turn to reject it.
    const result = reviewAskStreamEventSchema.safeParse({
      kind: "ask-delta",
      threadId: "th",
      channel: "orchestrator",
      delta: "x",
    });
    expect(result.success).toBe(false);
  });

  it("an empty turnId is rejected (min(1))", () => {
    const result = reviewAskStreamEventSchema.safeParse({
      kind: "ask-delta",
      threadId: "th",
      turnId: "",
      channel: "orchestrator",
      delta: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("the ask-stream discriminator never collides with project.process (#251)", () => {
  it("project.process's `done` is NOT a valid ask-stream event", () => {
    // Why the ask kinds are `ask-*`: a shared "done" would make a union of the two throw
    // at construction (duplicate discriminator). Disjoint literals keep them composable.
    expect(reviewAskStreamEventSchema.safeParse({ kind: "done", repos: [] }).success).toBe(false);
  });

  it("an ask-delta is NOT a valid projectProcessEvent", () => {
    expect(
      projectProcessEventSchema.safeParse({
        kind: "ask-delta",
        threadId: "th",
        turnId: "tn",
        channel: "orchestrator",
        delta: "x",
      }).success,
    ).toBe(false);
  });
});

describe("persisted-thread wire shapes (#251)", () => {
  it("a persisted thread round-trips its anchor, version, and messages (incl. interrupted)", () => {
    const thread = {
      threadId: "th",
      anchor: {
        kind: "range" as const,
        label: "src/a.ts:44-47",
        key: "range|src/a.ts|additions|44|47",
        side: "additions" as const,
      },
      harnessVersionAtCreation: "claude-code 1.2.3",
      messages: [
        { id: "m0", author: "you" as const, body: "why fail open?" },
        { id: "m1", author: "harness" as const, model: "Claude", body: "half an ans", status: "interrupted" as const },
      ],
    };
    expect(persistedThreadSchema.parse(thread)).toEqual(thread);
  });

  it("a conversation anchor accepts an optional side and context", () => {
    const anchor = {
      kind: "fragment" as const,
      label: "on: the fail-open note",
      key: 'fragment|["t","m"]',
      context: "the referenced sentence",
    };
    expect(conversationAnchorSchema.parse(anchor)).toEqual(anchor);
  });

  it("an in-flight turn carries the coalesced body-so-far for the renderer to resume", () => {
    const turn = {
      threadId: "th",
      turnId: "tn",
      channel: "orchestrator" as const,
      model: "Orchestrator · Claude",
      bodySoFar: "the part that already streamed",
    };
    expect(inFlightTurnSchema.parse(turn)).toEqual(turn);
  });
});

describe("review.reattach command + review.ask back-compat (#251)", () => {
  it("review.reattach input and output parse through the command registry", () => {
    const input = parseCommandInput("review.reattach", { commandId: UUID, reviewId: "r" });
    expect(input).toEqual({ commandId: UUID, reviewId: "r" });
    const output = parseCommandOutput("review.reattach", {
      threads: [],
      inFlight: [
        { threadId: "th", turnId: "tn", channel: "codex", model: "codex", bodySoFar: "" },
      ],
    });
    expect(reattachResultSchema.parse(output).inFlight).toHaveLength(1);
  });

  it("review.ask still accepts a bare #139 ask with no #251 fields (back-compat)", () => {
    const input = parseCommandInput("review.ask", {
      commandId: UUID,
      reviewId: "r",
      question: "why?",
    });
    // mode defaults to orchestrator; threadId/turnId/anchor stay absent.
    expect(input.mode).toBe("orchestrator");
    expect(input.threadId).toBeUndefined();
    expect(input.anchor).toBeUndefined();
  });

  it("review.ask accepts the #251 persistence fields when supplied", () => {
    const input = parseCommandInput("review.ask", {
      commandId: UUID,
      reviewId: "r",
      question: "why?",
      threadId: "th",
      turnId: "tn",
      anchor: { kind: "chunk", label: "src/a.ts", key: "chunk|src/a.ts" },
    });
    expect(input.threadId).toBe("th");
    expect(input.anchor?.kind).toBe("chunk");
  });
});
