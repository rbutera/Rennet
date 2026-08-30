import type { AskProjection, DraftBoard, LensKind, QuoteThread } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { applyAskEvent, emptyAskProjection } from "./ask-projection";
import { planQuoteThreadReanchors, selectableBoardText } from "./quote-reanchor";

const author = { kind: "lens-agent", id: "test" } as const;

function prose(id: string, markdown: string): DraftBoard["elements"][number] {
  return { id, kind: "prose", data: { author, markdown } };
}

function scenario(id: string, condition: string, response: string): DraftBoard["elements"][number] {
  return {
    id,
    kind: "prose",
    data: { author, markdown: "", scenario_clauses: { condition, response } },
  };
}

function decision(
  id: string,
  statement: string,
  alternatives: readonly string[] = [],
): DraftBoard["elements"][number] {
  return {
    id,
    kind: "decision",
    data: { author, statement, evidence: [], alternatives: [...alternatives], why: "because" },
  };
}

function requirement(
  id: string,
  shall: string,
  name: string,
  scenarios: readonly string[] = [],
  capability?: string,
  status?: string,
): DraftBoard["elements"][number] {
  return {
    id,
    kind: "requirement",
    data: {
      author,
      shall,
      name,
      scenarios: [...scenarios],
      ...(capability === undefined ? {} : { capability }),
      ...(status === undefined ? {} : { status }),
    },
  };
}

function orderStep(id: string, title: string): DraftBoard["elements"][number] {
  return { id, kind: "order_step", data: { author, title, span: "code-ref", children: [] } };
}

function section(id: string, title: string): DraftBoard["elements"][number] {
  return { id, kind: "section", data: { author, title, children: [] } };
}

function roundOutcome(id: string, askText: string, note: string): DraftBoard["elements"][number] {
  return {
    id,
    kind: "round_outcome",
    data: { author, status: "addressed", ask: { ref: "ask-ref", text: askText }, note },
  };
}

function board(...elements: DraftBoard["elements"]): DraftBoard {
  return { elements };
}

function boards(lens: LensKind, value: DraftBoard): ReadonlyMap<LensKind, DraftBoard> {
  return new Map([[lens, value]]);
}

function projection(thread: QuoteThread): AskProjection {
  return {
    ...emptyAskProjection(),
    quoteThreads: { thread: thread },
  };
}

function onlyEvent(events: readonly ReturnType<typeof planQuoteThreadReanchors>[number][]) {
  expect(events).toHaveLength(1);
  const event = events[0];
  if (event === undefined) throw new Error("Expected one quote re-anchor event.");
  return event;
}

const scopedThread: QuoteThread = {
  anchor: "one durable sentence",
  lifecycle: "attached",
  target: "old-prose",
  generation: "gen-1",
  messages: [
    { author: "user", text: "Keep this exact." },
    { author: "orchestrator", text: "Understood." },
  ],
};

describe("planQuoteThreadReanchors", () => {
  it("moves a scoped thread to the unique successor match without losing its exchange", () => {
    const events = planQuoteThreadReanchors({
      projection: projection(scopedThread),
      sourceGeneration: "gen-1",
      successorGeneration: "gen-2",
      previous: boards("design", board(prose("old-prose", "one durable sentence"))),
      successor: boards("design", board(prose("new-prose", "prefix one durable sentence suffix"))),
    });

    expect(events).toEqual([
      {
        kind: "quote-open",
        threadId: "thread",
        thread: {
          ...scopedThread,
          lifecycle: "attached",
          target: "new-prose",
          generation: "gen-2",
        },
      },
    ]);
    expect(
      applyAskEvent(projection(scopedThread), onlyEvent(events)).quoteThreads.thread?.messages,
    ).toEqual(scopedThread.messages);
  });

  it("marks the thread detached when no successor text matches", () => {
    const events = planQuoteThreadReanchors({
      projection: projection(scopedThread),
      sourceGeneration: "gen-1",
      successorGeneration: "gen-2",
      previous: boards("design", board(prose("old-prose", "one durable sentence"))),
      successor: boards("design", board(prose("new-prose", "the sentence was removed"))),
    });

    expect(events).toEqual([
      {
        kind: "quote-open",
        threadId: "thread",
        thread: { ...scopedThread, lifecycle: "detached" },
      },
    ]);
  });

  it("marks the thread detached when the successor text is ambiguous in its lens", () => {
    const events = planQuoteThreadReanchors({
      projection: projection(scopedThread),
      sourceGeneration: "gen-1",
      successorGeneration: "gen-2",
      previous: boards("design", board(prose("old-prose", "one durable sentence"))),
      successor: boards(
        "design",
        board(
          prose("candidate-a", "one durable sentence"),
          prose("candidate-b", "one durable sentence"),
        ),
      ),
    });

    expect(events[0]).toMatchObject({
      kind: "quote-open",
      threadId: "thread",
      thread: { lifecycle: "detached", target: "old-prose", generation: "gen-1" },
    });
  });

  it("does not cross lenses to find a successor", () => {
    const events = planQuoteThreadReanchors({
      projection: projection(scopedThread),
      sourceGeneration: "gen-1",
      successorGeneration: "gen-2",
      previous: boards("design", board(prose("old-prose", "one durable sentence"))),
      successor: boards("sequence", board(prose("wrong-lens", "one durable sentence"))),
    });

    expect(events[0]).toMatchObject({ thread: { lifecycle: "detached" } });
  });

  it("retains generic threads and ignores threads from another generation", () => {
    const generic: QuoteThread = {
      anchor: "one durable sentence",
      messages: [{ author: "user", text: "Generic history" }],
    };
    const existing = projection(scopedThread);
    const mixed: AskProjection = {
      ...existing,
      quoteThreads: {
        generic,
        older: { ...scopedThread, generation: "gen-0" },
      },
    };

    expect(
      planQuoteThreadReanchors({
        projection: mixed,
        sourceGeneration: "gen-1",
        successorGeneration: "gen-2",
        previous: boards("design", board(prose("old-prose", "one durable sentence"))),
        successor: boards("design", board(prose("new-prose", "one durable sentence"))),
      }),
    ).toEqual([]);
  });

  it("is idempotent once a detach event has landed", () => {
    const first = planQuoteThreadReanchors({
      projection: projection(scopedThread),
      sourceGeneration: "gen-1",
      successorGeneration: "gen-2",
      previous: boards("design", board(prose("old-prose", "one durable sentence"))),
      successor: boards("design", board()),
    });
    const detached = applyAskEvent(projection(scopedThread), onlyEvent(first));

    expect(
      planQuoteThreadReanchors({
        projection: detached,
        sourceGeneration: "gen-1",
        successorGeneration: "gen-2",
        previous: boards("design", board(prose("old-prose", "one durable sentence"))),
        successor: boards("design", board()),
      }),
    ).toEqual([]);
  });

  it("POSITIVE CONTROL: a second occurrence inside one successor element is ambiguous", () => {
    const events = planQuoteThreadReanchors({
      projection: projection(scopedThread),
      sourceGeneration: "gen-1",
      successorGeneration: "gen-2",
      previous: boards("design", board(prose("old-prose", "one durable sentence"))),
      successor: boards(
        "design",
        board(prose("repeated", "one durable sentence, then one durable sentence again")),
      ),
    });

    expect(events[0]).toMatchObject({ thread: { lifecycle: "detached" } });
  });

  it.each([
    {
      label: "decision statement",
      quote: "Keep commands retryable",
      previous: [decision("old-decision", "Keep commands retryable")],
      successor: [decision("new-decision", "Keep commands retryable")],
      oldTarget: "old-decision",
      newTarget: "new-decision",
    },
    {
      label: "decision alternative",
      quote: "Store a mutable cursor",
      previous: [decision("old-decision", "Use immutable turns", ["Store a mutable cursor"])],
      successor: [decision("new-decision", "Use immutable turns", ["Store a mutable cursor"])],
      oldTarget: "old-decision",
      newTarget: "new-decision",
    },
    {
      label: "requirement name",
      quote: "Resume an interrupted round",
      previous: [
        requirement("old-requirement", "The host SHALL resume.", "Resume an interrupted round"),
      ],
      successor: [
        requirement("new-requirement", "The host SHALL resume.", "Resume an interrupted round"),
      ],
      oldTarget: "old-requirement",
      newTarget: "new-requirement",
    },
    {
      label: "requirement capability",
      quote: "round-resume",
      previous: [
        requirement("old-requirement", "The host SHALL resume.", "Resume", [], "round-resume"),
      ],
      successor: [
        requirement("new-requirement", "The host SHALL resume.", "Resume", [], "round-resume"),
      ],
      oldTarget: "old-requirement",
      newTarget: "new-requirement",
    },
    {
      label: "referenced requirement scenario",
      quote: "WHEN the harness reconnects",
      previous: [
        requirement("old-requirement", "The host SHALL resume.", "Resume", ["old-scenario"]),
        scenario("old-scenario", "WHEN the harness reconnects", "THEN continue the same turn"),
      ],
      successor: [
        requirement("new-requirement", "The host SHALL resume.", "Resume", ["new-scenario"]),
        scenario("new-scenario", "WHEN the harness reconnects", "THEN continue the same turn"),
      ],
      oldTarget: "old-scenario",
      newTarget: "new-scenario",
    },
    {
      label: "order-step title",
      quote: "Run the focused test",
      previous: [orderStep("old-step", "Run the focused test")],
      successor: [orderStep("new-step", "Run the focused test")],
      oldTarget: "old-step",
      newTarget: "new-step",
    },
    {
      label: "section title",
      quote: "Failure recovery",
      previous: [section("old-section", "Failure recovery")],
      successor: [section("new-section", "Failure recovery")],
      oldTarget: "old-section",
      newTarget: "new-section",
    },
    {
      label: "round outcome ask",
      quote: "Keep the exchange after reload",
      previous: [
        roundOutcome("old-outcome", "Keep the exchange after reload", "The exchange persisted."),
      ],
      successor: [
        roundOutcome("new-outcome", "Keep the exchange after reload", "The exchange persisted."),
      ],
      oldTarget: "old-outcome",
      newTarget: "new-outcome",
    },
    {
      label: "round outcome note",
      quote: "The exchange persisted",
      previous: [
        roundOutcome("old-outcome", "Keep the exchange after reload", "The exchange persisted."),
      ],
      successor: [
        roundOutcome("new-outcome", "Keep the exchange after reload", "The exchange persisted."),
      ],
      oldTarget: "old-outcome",
      newTarget: "new-outcome",
    },
  ])(
    "reanchors a quote selected from a $label",
    ({ quote, previous, successor, oldTarget, newTarget }) => {
      const thread: QuoteThread = {
        ...scopedThread,
        anchor: quote,
        target: oldTarget,
      };

      const events = planQuoteThreadReanchors({
        projection: projection(thread),
        sourceGeneration: "gen-1",
        successorGeneration: "gen-2",
        previous: boards("design", board(...previous)),
        successor: boards("design", board(...successor)),
      });

      expect(events[0]).toMatchObject({
        thread: { lifecycle: "attached", target: newTarget, generation: "gen-2" },
      });
    },
  );

  it("projects only text fields backed by a durable quote renderer", () => {
    const projected = selectableBoardText(
      board(
        decision("decision-1", "Choose append-only state", ["Rewrite in place"]),
        requirement(
          "requirement-1",
          "The log SHALL be durable.",
          "Durable ask log",
          ["scenario-1"],
          "session-resume",
          "in-progress",
        ),
        scenario("scenario-1", "WHEN the app reloads", "THEN restore the exchange"),
        prose("prose-1", "Reader-visible prose"),
        orderStep("step-1", "Persist before broadcasting"),
        {
          id: "glossary-1",
          kind: "prose",
          data: {
            author,
            markdown: "hidden glossary fallback",
            glossary_term: {
              term: "Round receipt",
              definition: "The durable account of one completed round.",
              avoid: ["turn summary"],
            },
            requirement_refs: ["R2.1"],
            acceptance_criteria: ["persists after reload"],
          },
        },
        {
          id: "section-1",
          kind: "section",
          data: {
            author,
            title: "Recovery",
            children: [],
            task_manifest: {
              files: [{ operation: "modify", value: "packages/core/src/exits.ts" }],
              interfaces: [{ direction: "preserve", value: "AskProjection" }],
              verifications: [{ run: "pnpm check", expected: "all targets pass" }],
            },
          },
        },
        {
          id: "finding-1",
          kind: "finding",
          data: {
            author,
            severity: "high",
            concern: "The exchange disappears. **Fix:** Persist it before reload.",
            code: ["code-ref"],
            concurrence: [{ model: "reviewer-model", agree: 1, total: 1 }],
            status: "open",
          },
        },
        {
          id: "noise-1",
          kind: "noise_verdict",
          data: {
            author,
            hunk: "code-ref",
            verdict: "noise",
            reason: "Generated bytes only.",
            judge: "deterministic",
          },
        },
        {
          id: "callout-1",
          kind: "callout",
          data: { author, variant: "note", body: "Mind the retry." },
        },
        {
          id: "annotation-1",
          kind: "annotation",
          data: { author, code_ref: "code-ref", body: "The write happens here." },
        },
        roundOutcome("outcome-1", "Keep the exchange", "It survives reload."),
      ),
    );

    expect(projected).toEqual([
      { target: "decision-1", text: "Choose append-only state" },
      { target: "decision-1", text: "because" },
      { target: "decision-1", text: "Rewrite in place" },
      { target: "requirement-1", text: "Durable ask log" },
      { target: "requirement-1", text: "session-resume" },
      { target: "requirement-1", text: "The log SHALL be durable." },
      { target: "scenario-1", text: "WHEN the app reloads" },
      { target: "scenario-1", text: "THEN restore the exchange" },
      { target: "prose-1", text: "Reader-visible prose" },
      { target: "step-1", text: "Persist before broadcasting" },
      { target: "section-1", text: "Recovery" },
      { target: "finding-1", text: "The exchange disappears." },
      { target: "finding-1", text: "Persist it before reload." },
      { target: "noise-1", text: "Generated bytes only." },
      { target: "callout-1", text: "Mind the retry." },
      { target: "annotation-1", text: "The write happens here." },
      { target: "outcome-1", text: "Keep the exchange" },
      { target: "outcome-1", text: "It survives reload." },
    ]);
  });

  it("does not use an arbitrary target id as selectable source text", () => {
    const thread: QuoteThread = {
      ...scopedThread,
      anchor: "old-prose",
      target: "old-prose",
    };

    const events = planQuoteThreadReanchors({
      projection: projection(thread),
      sourceGeneration: "gen-1",
      successorGeneration: "gen-2",
      previous: boards("design", board(prose("old-prose", "Different reader text"))),
      successor: boards("design", board(prose("new-prose", "old-prose"))),
    });

    expect(events[0]).toMatchObject({ thread: { lifecycle: "detached" } });
  });
});
