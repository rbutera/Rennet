// @vitest-environment happy-dom
import type { LensBoard } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../../data";
import { selectExitPipCount } from "../../handoff/selectors";
import { type AnchoredAsk, AnchoredAskProvider } from "../../review/anchored-ask";
import { useRennetStore } from "../../store";
import { mount, waitFor } from "../../test/dom";
import {
  decisionsBoard,
  designBoard,
  flaggedBoard,
  noiseBoard,
  sequenceBoard,
} from "../../test/fixtures/boards";
import { MemoryBridge, refusesSpanRead, SPAN_OUTSIDE_CAPTURE } from "../../test/memory-bridge";
import { findingAskId, findingRef } from "../finding-lifecycle";
import { BoardElement, BoardElementsProvider } from "./index";

// Cluster 3's registry, exercised over the cluster-1 fixture boards — their union is
// arranged to cover every board kind. Each renderer stamps a `data-kind` marker (its
// distinctive DOM), so rendering the whole set proves the map is total in practice, not
// just at the type level. Citations hydrate through the span-read seam; the stub refuses
// the way the daemon refuses an uncaptured span, so a code_ref reads that exact reason.

const ALL_BOARDS: readonly LensBoard[] = [
  designBoard,
  decisionsBoard,
  sequenceBoard,
  flaggedBoard,
  noiseBoard,
];

const BOARD_KINDS = [
  "prose",
  "callout",
  "annotation",
  "code_ref",
  "finding",
  "decision",
  "requirement",
  "order_step",
  "message",
  "noise_verdict",
  "section",
] as const;

beforeEach(() => {
  useRennetStore.getState().reviewActions.resetReview();
  useRennetStore.getState().uiActions.setChatOpen(false);
});

/** Render every element of a board through the registry (deduped — a citation reused
 *  across two sections appears twice in the flat pool). */
function renderBoard(board: LensBoard, anchoredAsk: AnchoredAsk | null = null) {
  const unique = [...new Map(board.elements.map((el) => [el.id, el])).values()];
  return mount(
    <BridgeProvider bridge={new MemoryBridge({ "patchset.readSpan": refusesSpanRead })}>
      <AnchoredAskProvider value={anchoredAsk}>
        <BoardElementsProvider
          elements={board.elements}
          reviewId="rev-1"
          generation={board.generation}
          boardId={board.boardId}
        >
          {unique.map((el) => (
            <BoardElement key={el.id} element={el} />
          ))}
        </BoardElementsProvider>
      </AnchoredAskProvider>
    </BridgeProvider>,
  );
}

describe("board kind renderers over the fixture set", () => {
  it("renders every registered board kind's distinctive DOM across the fixtures", () => {
    const present = new Set<string>();
    for (const board of ALL_BOARDS) {
      const { container, unmount } = renderBoard(board);
      for (const node of container.querySelectorAll("[data-kind]")) {
        const kind = node.getAttribute("data-kind");
        if (kind) present.add(kind);
      }
      unmount();
    }
    for (const kind of BOARD_KINDS) expect(present.has(kind)).toBe(true);
  });

  it("surfaces the daemon's OWN refusal for a code_ref it cannot read", async () => {
    // A decision's evidence renders through CodeTabs, which hydrates its active citation
    // on mount; a refusing dispatch returns error, and the reviewer reads the reason the
    // daemon gave rather than a fixed sentence the surface made up.
    const { getAllByText } = renderBoard(designBoard);
    await waitFor(() =>
      expect(getAllByText(new RegExp(SPAN_OUTSIDE_CAPTURE)).length).toBeGreaterThan(0),
    );
  });

  it("a finding stages and unstages one board-attempt-scoped request, hiding Dismiss while staged", async () => {
    const { container, user } = renderBoard(flaggedBoard);
    // f1 cites cr-f1 → github-auth.ts:244; its `**Fix:**` mints the actionable callout.
    const finding = container.querySelector<HTMLElement>(
      '[data-kind="finding"][data-element-id="f1"]',
    );
    if (!finding) throw new Error("missing f1 finding");
    const findAction = (label: string) =>
      [...finding.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === label,
      );
    const request = findAction("Request This Change");
    if (!request) throw new Error("missing request action");
    await user.click(request);
    const ref = findingRef(flaggedBoard.generation, flaggedBoard.boardId, "f1");
    const askId = findingAskId(ref);
    expect(useRennetStore.getState().review.stagedAsks[askId]).toEqual({
      id: askId,
      anchor: "packages/adapters/src/github-auth.ts:244",
      type: "request-change",
      body: "write a secret-free terminal record on every exit.",
      finding: ref,
      side: "RIGHT",
      codeRef: {
        patchsetId: "ps-438",
        path: "packages/adapters/src/github-auth.ts",
        side: "head",
        startLine: 244,
        endLine: 266,
      },
    });
    await waitFor(() => expect(findAction("Dismiss")).toBeUndefined());

    const stagedControl = findAction("Staged · Request Change");
    if (!stagedControl) throw new Error("missing staged request action");
    await user.click(stagedControl);
    expect(useRennetStore.getState().review.stagedAsks[askId]).toBeUndefined();
    await waitFor(() => expect(findAction("Dismiss")).toBeDefined());
  });

  it("stages a deletion-side finding against the base hunk", async () => {
    const board: LensBoard = {
      ...flaggedBoard,
      elements: flaggedBoard.elements.map((element) =>
        element.kind === "code_ref" && element.id === "cr-f1"
          ? { ...element, data: { ...element.data, side: "base" } }
          : element,
      ),
    };
    const { container, user } = renderBoard(board);
    const finding = container.querySelector<HTMLElement>(
      '[data-kind="finding"][data-element-id="f1"]',
    );
    const request = [...(finding?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent === "Request This Change",
    );
    if (!request) throw new Error("missing request action");

    await user.click(request);

    const ref = findingRef(board.generation, board.boardId, "f1");
    expect(useRennetStore.getState().review.stagedAsks[findingAskId(ref)]).toMatchObject({
      side: "LEFT",
      codeRef: {
        patchsetId: "ps-438",
        path: "packages/adapters/src/github-auth.ts",
        side: "base",
        startLine: 244,
        endLine: 266,
      },
    });
  });

  it("keeps every action available when a schema-valid finding has no Fix marker", async () => {
    const board: LensBoard = {
      ...flaggedBoard,
      elements: flaggedBoard.elements.map((element) =>
        element.kind === "finding" && element.id === "f1"
          ? {
              ...element,
              data: {
                ...element.data,
                concern: "The refresh path can exit without a terminal record.",
              },
            }
          : element,
      ),
    };
    const { container, user } = renderBoard(board);
    const finding = container.querySelector<HTMLElement>(
      '[data-kind="finding"][data-element-id="f1"]',
    );
    if (!finding) throw new Error("missing f1 finding");
    const action = (label: string) =>
      [...finding.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === label,
      );

    expect(action("Dismiss")).toBeDefined();
    expect(action("Discuss")).toBeDefined();
    const request = action("Request This Change");
    if (!request) throw new Error("missing request action");
    await user.click(request);

    const ref = findingRef(board.generation, board.boardId, "f1");
    expect(useRennetStore.getState().review.stagedAsks[findingAskId(ref)]?.body).toBe(
      "The refresh path can exit without a terminal record.",
    );
  });

  it("exposes both recovery actions for a concurrent request and dismissal", async () => {
    const ref = findingRef(flaggedBoard.generation, flaggedBoard.boardId, "f1");
    const askId = findingAskId(ref);
    const actions = useRennetStore.getState().reviewActions;
    actions.dismissFinding(ref);
    actions.stageAsk({
      id: askId,
      anchor: "packages/adapters/src/github-auth.ts:244",
      type: "request-change",
      body: "write a secret-free terminal record on every exit.",
      finding: ref,
    });

    const { container, user } = renderBoard(flaggedBoard);
    const finding = container.querySelector<HTMLElement>(
      '[data-kind="finding"][data-element-id="f1"]',
    );
    if (!finding) throw new Error("missing f1 finding");
    const disclosure = finding.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (!disclosure) throw new Error("missing finding disclosure");
    await user.click(disclosure);
    const action = (label: string) =>
      [...finding.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === label,
      );

    await waitFor(() => {
      expect(action("Dismissed · Undo")).toBeDefined();
      expect(action("Staged · Request Change")).toBeDefined();
    });
    const undo = action("Dismissed · Undo");
    if (!undo) throw new Error("missing dismissal recovery");
    await user.click(undo);
    expect(useRennetStore.getState().review.findingDispositions).toEqual({});

    const unstage = action("Staged · Request Change");
    if (!unstage) throw new Error("missing request recovery");
    await user.click(unstage);
    expect(useRennetStore.getState().review.stagedAsks[askId]).toBeUndefined();
    await waitFor(() => expect(action("Dismiss")).toBeDefined());
  });

  it("overlays a reversible dismissal, dims and folds it, and leaves it peekable", async () => {
    const { container, getAllByText, user } = renderBoard(flaggedBoard);
    const finding = container.querySelector<HTMLElement>(
      '[data-kind="finding"][data-element-id="f1"]',
    );
    const disclosure = finding?.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");

    const [dismiss] = getAllByText("Dismiss");
    if (!dismiss) throw new Error("missing Dismiss action");
    await user.click(dismiss);
    await waitFor(() => {
      expect(finding?.getAttribute("data-status")).toBe("dismissed");
      expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    });
    if (!finding) throw new Error("missing f1 finding");
    expect(finding.className).not.toContain("opacity-60");
    expect(finding.querySelector('[class~="opacity-60"]')).toBeTruthy();
    expect(finding.textContent).toContain(", dismissed");

    if (!disclosure) throw new Error("missing finding disclosure");
    await user.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const [undo] = getAllByText("Dismissed · Undo");
    if (!undo) throw new Error("missing dismissal Undo action");
    const [discuss] = getAllByText("Discuss");
    if (!discuss) throw new Error("missing Discuss action");
    expect(undo.closest('[class~="opacity-60"]')).toBeNull();
    expect(discuss.closest('[class~="opacity-60"]')).toBeNull();
    await user.click(undo);
    await waitFor(() => {
      expect(finding?.getAttribute("data-status")).toBe("open");
      expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("Discuss cites the fix, focuses the persistent chat, and dispatches one anchored turn", async () => {
    const sent: Parameters<AnchoredAsk>[0][] = [];
    const startingFocusRevision = useRennetStore.getState().ui.chatComposerFocusRevision;
    const { getAllByRole, user } = renderBoard(flaggedBoard, async (input) => {
      sent.push(input);
    });
    const [discuss] = getAllByRole("button", { name: "Discuss" });
    if (!discuss) throw new Error("missing Discuss action");
    await user.click(discuss);

    const state = useRennetStore.getState();
    const [threadId] = Object.keys(state.review.quoteThreads);
    if (!threadId) throw new Error("missing Discuss thread");
    const fix = "write a secret-free terminal record on every exit.";
    expect(state.review.quoteThreads[threadId]).toEqual({
      anchor: fix,
      kind: "explain",
      target: "f1",
      generation: flaggedBoard.generation,
      messages: [{ author: "user", text: "Discuss this fix." }],
    });
    expect(selectExitPipCount(state)).toBe(0);
    expect(state.review.focusedThreadId).toBeNull();
    expect(state.ui.chatOpen).toBe(true);
    expect(state.ui.chatComposerFocusRevision).toBe(startingFocusRevision + 1);
    expect(sent).toEqual([
      {
        threadId,
        question: "Discuss this fix.",
        excerpt: fix,
        target: "f1",
        generation: flaggedBoard.generation,
      },
    ]);
  });

  it("renders a requirement's coverage verdict and a message's role + quote", () => {
    const design = renderBoard(designBoard);
    expect(
      design.container.querySelector("[data-kind=requirement][data-coverage=met]"),
    ).toBeTruthy();
    design.unmount();

    const flagged = renderBoard(flaggedBoard);
    const message = flagged.container.querySelector("[data-kind=message][data-role=discuss]");
    expect(message).toBeTruthy();
    expect(message?.querySelector("blockquote")?.textContent).toContain(
      "connection and token are untouched",
    );
  });

  it("dims a noise verdict and stages a comment ask when the reviewer disagrees", async () => {
    const { container, getAllByText, user } = renderBoard(noiseBoard);
    expect(container.querySelector("[data-kind=noise_verdict][data-verdict=noise]")).toBeTruthy();
    const [firstNotNoise] = getAllByText("Not noise");
    expect(firstNotNoise).toBeDefined();
    if (firstNotNoise) await user.click(firstNotNoise);
    const asks = Object.values(useRennetStore.getState().review.stagedAsks);
    expect(asks.some((a) => a.type === "comment")).toBe(true);
  });
});
