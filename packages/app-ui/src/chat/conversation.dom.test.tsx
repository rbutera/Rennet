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
});
