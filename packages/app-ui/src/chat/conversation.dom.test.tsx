// @vitest-environment happy-dom
//
// C07 cluster 2 (task 2.3): the transcript renders its turn regions, code in a turn
// body goes through C4's shared `review/code-block.tsx` (a line comment written from it
// lands in `review.codeComments` — the ONE code path, reconciliation 4), and the record-
// vs-arrival distinction holds: a historical turn does NOT word-animate, a live one does.
import { FileText, Search } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, mount, screen } from "../test/dom";
import type { TranscriptRow } from "./chat-data";
import { ConversationPane } from "./conversation-pane";

afterEach(() => {
  cleanup();
  act(() => useRennetStore.getState().reviewActions.resetReview());
});

const EMPTY_LIVE: ReadonlySet<string> = new Set();

const userTurn: TranscriptRow = {
  kind: "turn",
  id: "u1",
  speaker: "user",
  status: "complete",
  time: "10:52",
  paragraphs: ["Does the middleware reorder touch any public routes?"],
};

const orchestratorTurn: TranscriptRow = {
  kind: "turn",
  id: "o1",
  speaker: "orchestrator",
  status: "complete",
  lead: "Pulling the actual diff rather than paraphrasing it.",
  paragraphs: [],
  preface: [
    {
      kind: "action",
      id: "a1",
      label: "Read 2 files",
      detail: "middleware/index.ts",
      status: "complete",
      icon: FileText,
    },
    {
      kind: "action",
      id: "a2",
      label: "Searched codebase",
      detail: "requireScope · 4 matches",
      status: "complete",
      icon: Search,
    },
  ],
  body: [
    { kind: "text", text: "Here is the composed order the request goes through:" },
    {
      kind: "code",
      path: "packages/api/middleware/index.ts",
      startLine: 12,
      highlightLines: [14],
      code: "export const middleware = compose(\n  authGuard,\n  scopeGuard,\n)",
    },
  ],
};

describe("transcript turns (task 2.3)", () => {
  it("renders a user bubble and an orchestrator turn's regions", () => {
    mount(<ConversationPane rows={[userTurn, orchestratorTurn]} liveIds={EMPTY_LIVE} />);
    // User bubble.
    expect(screen.getByText(/Does the middleware reorder/)).toBeTruthy();
    // Orchestrator lead prose + an activity step + body prose.
    expect(screen.getByText(/Pulling the actual diff/)).toBeTruthy();
    expect(screen.getByText(/Read 2 files/)).toBeTruthy();
    expect(screen.getByText(/composed order the request/)).toBeTruthy();
  });

  it("renders a turn's code through the shared review/code-block, and a line comment from it lands in review.codeComments", async () => {
    const { user } = mount(<ConversationPane rows={[orchestratorTurn]} liveIds={EMPTY_LIVE} />);
    // The shared CodeBlock renders the file header + numbered lines (data-line attributes).
    expect(screen.getByText("packages/api/middleware/index.ts")).toBeTruthy();
    expect(document.querySelector('[data-line="12"]')).toBeTruthy();

    // Open the line-2 (absolute 13) comment editor, type, save — the shared path writes the store.
    await user.click(screen.getByLabelText("Comment on line 13"));
    await user.type(screen.getByPlaceholderText(/Leave a comment on this line/), "off-by-one here");
    await user.click(screen.getByText("Save"));

    const stored =
      useRennetStore.getState().review.codeComments["packages/api/middleware/index.ts"];
    expect(stored?.[13]).toBe("off-by-one here");
  });

  it("does not word-animate a historical turn, but does animate an appended live one", () => {
    const { container, rerender } = mount(
      <ConversationPane rows={[orchestratorTurn]} liveIds={EMPTY_LIVE} />,
    );
    // Record: no per-word reveal spans.
    expect(container.querySelectorAll(".animate-word-in").length).toBe(0);

    // The same turn, now marked live (arrived this mount) — its prose word-animates.
    rerender(<ConversationPane rows={[orchestratorTurn]} liveIds={new Set(["o1"])} />);
    expect(container.querySelectorAll(".animate-word-in").length).toBeGreaterThan(0);
  });

  it("renders prose and tool activity in the harness's exact occurrence order", () => {
    const ordered: TranscriptRow = {
      kind: "turn",
      id: "ordered",
      speaker: "orchestrator",
      status: "complete",
      paragraphs: ["Before the tool.", "After the tool."],
      blocks: [
        { kind: "text", text: "Before the tool." },
        {
          kind: "action",
          id: "a-ordered",
          label: "Read",
          detail: "src/a.ts",
          status: "complete",
          icon: FileText,
        },
        { kind: "text", text: "After the tool." },
      ],
    };
    mount(<ConversationPane rows={[ordered]} liveIds={EMPTY_LIVE} />);
    const before = screen.getByText("Before the tool.");
    const action = screen.getByText(/Read · src\/a\.ts/);
    const after = screen.getByText("After the tool.");
    expect(before.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders CONSECUTIVE activity blocks as one sequence, not one wrapper each", () => {
    // Each activity block used to get its own ActivitySequence, which put the transcript's
    // block gap between steps that belong to one another. Assert the shape, not the pixels:
    // the two adjacent steps share a parent, and the step across the prose does not.
    const run: TranscriptRow = {
      kind: "turn",
      id: "grouped",
      speaker: "orchestrator",
      status: "complete",
      paragraphs: [],
      blocks: [
        {
          kind: "action",
          id: "g1",
          label: "Read",
          detail: "a.ts",
          status: "complete",
          icon: FileText,
        },
        {
          kind: "action",
          id: "g2",
          label: "Read",
          detail: "b.ts",
          status: "complete",
          icon: FileText,
        },
        { kind: "text", text: "Then some prose." },
        {
          kind: "action",
          id: "g3",
          label: "Read",
          detail: "c.ts",
          status: "complete",
          icon: FileText,
        },
      ],
    };
    const { container } = mount(<ConversationPane rows={[run]} liveIds={EMPTY_LIVE} />);

    const stepOf = (detail: string) =>
      screen.getByText(new RegExp(`Read · ${detail.replace(".", "\\.")}`)).closest("div")
        ?.parentElement;
    const a = stepOf("a.ts");
    const b = stepOf("b.ts");
    const c = stepOf("c.ts");
    expect(a).not.toBeNull();
    // The two adjacent steps live in the SAME sequence…
    expect(a).toBe(b);
    // …and the one on the far side of the prose does not.
    expect(c).not.toBe(a);
    // Which is three activity blocks in exactly two sequences.
    const sequences = new Set([a, b, c]);
    expect(sequences.size).toBe(2);
    expect(container.textContent).toContain("Then some prose.");
  });

  it("bottom-anchors a just-minted session and returns to the ordinary column on a reply", () => {
    const sent: TranscriptRow = {
      kind: "turn",
      id: "u-first",
      speaker: "user",
      status: "complete",
      paragraphs: ["Review the span fix."],
    };
    const replied: TranscriptRow = {
      kind: "turn",
      id: "o-first",
      speaker: "orchestrator",
      status: "complete",
      paragraphs: ["Reading it now."],
    };
    const column = (container: HTMLElement) =>
      container.querySelector("[data-transcript-state]") as HTMLElement;

    const { container, rerender } = mount(<ConversationPane rows={[sent]} liveIds={EMPTY_LIVE} />);
    expect(column(container).dataset.transcriptState).toBe("awaiting-first-reply");
    expect(column(container).className).toContain("justify-end");
    expect(column(container).className).toContain("h-full");

    // The orchestrator answers: the ordinary top-aligned transcript takes over.
    rerender(<ConversationPane rows={[sent, replied]} liveIds={EMPTY_LIVE} />);
    expect(column(container).dataset.transcriptState).toBe("conversation");
    expect(column(container).className).not.toContain("justify-end");
    expect(column(container).className).toContain("py-6");
  });

  it("does not reveal final prose until the preceding activity settles", () => {
    const streaming: TranscriptRow = {
      kind: "turn",
      id: "ordered-live",
      speaker: "orchestrator",
      status: "streaming",
      paragraphs: ["Before the tool.", "After the tool."],
      blocks: [
        { kind: "text", text: "Before the tool." },
        {
          kind: "action",
          id: "a-live",
          label: "Stage ask",
          status: "streaming",
          icon: FileText,
        },
        { kind: "text", text: "After the tool." },
      ],
    };
    const { container, rerender } = mount(
      <ConversationPane rows={[streaming]} liveIds={new Set(["ordered-live"])} />,
    );
    expect(container.textContent).toContain("Before the tool.");
    expect(screen.getByText("Stage ask")).toBeTruthy();
    expect(container.textContent).not.toContain("After the tool.");

    const settled: TranscriptRow = {
      ...streaming,
      status: "complete",
      blocks: streaming.blocks?.map((block) =>
        block.kind === "action" ? { ...block, status: "complete" as const } : block,
      ),
    };
    rerender(<ConversationPane rows={[settled]} liveIds={new Set(["ordered-live"])} />);
    expect(container.textContent).toContain("After the tool.");
  });
});

// ── A settled turn does not re-render on a delta to another turn (perf audit §5 H8) ──────
//
// The audit's "every Turn re-renders per streamed token": each `ask-delta` rebuilds the rows
// array, and an unmemoized `Turn` re-grouped its blocks and re-split every paragraph on each
// one, for every turn in the session. `memo(Turn)` only bites because Wave 2 made a settled
// turn's row object identity-stable across deltas — so this test is really pinning the pair,
// and it fails if EITHER the memo goes or row identity starts churning.
//
// The probe is an icon component, because an action step renders `step.icon` directly: it
// counts renders of the settled turn's subtree without instrumenting the component itself.
describe("transcript re-render blast radius (perf audit §5 H8)", () => {
  let probeRenders = 0;
  const Probe = (props: Record<string, unknown>) => {
    probeRenders += 1;
    return <svg data-testid="probe" {...props} />;
  };

  const settledTurn: TranscriptRow = {
    kind: "turn",
    id: "settled",
    speaker: "orchestrator",
    status: "complete",
    paragraphs: ["That middleware order is unchanged."],
    preface: [
      {
        kind: "action",
        id: "settled-a1",
        label: "Read 2 files",
        status: "complete",
        icon: Probe as unknown as typeof FileText,
      },
    ],
  };
  const liveTurn: TranscriptRow = {
    kind: "turn",
    id: "live",
    speaker: "orchestrator",
    status: "streaming",
    paragraphs: ["Pulling"],
  };
  const LIVE: ReadonlySet<string> = new Set(["live"]);

  it("a delta to the live turn leaves the settled turn unrendered", () => {
    probeRenders = 0;
    const { container, rerender } = mount(
      <ConversationPane rows={[settledTurn, liveTurn]} liveIds={LIVE} />,
    );
    expect(probeRenders).toBe(1);

    // A delta: a NEW rows array and a NEW live-turn object, but the settled turn is the same
    // object — which is exactly what `foldAskStream` + the per-thread WeakMaps produce.
    const grown: TranscriptRow = { ...liveTurn, paragraphs: ["Pulling the actual diff"] };
    rerender(<ConversationPane rows={[settledTurn, grown]} liveIds={LIVE} />);
    // The delta really landed (this assertion is what stops the one above passing vacuously)…
    expect(container.textContent).toContain("Pulling the actual diff");
    // …and the settled turn did not re-render for it.
    expect(probeRenders).toBe(1);

    // POSITIVE CONTROL: the probe is wired and CAN count. Give the settled turn a fresh row
    // identity — a real edit to that turn — and it renders again.
    rerender(<ConversationPane rows={[{ ...settledTurn }, grown]} liveIds={LIVE} />);
    expect(probeRenders).toBe(2);
  });
});
