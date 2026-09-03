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
    // The fade is ONE transition on the finding wrapper, not a per-child opacity snap:
    // dimming the card as a unit is what makes it cross-fade rather than flicker. So the
    // dimming class exists on the wrapper and NOWHERE inside it — put `opacity-50` on any
    // descendant and this reddens.
    expect(finding.className).toContain("opacity-50");
    expect(finding.className).toContain("transition-opacity");
    expect([...finding.querySelectorAll('[class~="opacity-50"]')]).toEqual([]);
    expect(finding.textContent).toContain(", dismissed");

    if (!disclosure) throw new Error("missing finding disclosure");
    await user.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const [undo] = getAllByText("Dismissed · Undo");
    if (!undo) throw new Error("missing dismissal Undo action");
    const [discuss] = getAllByText("Discuss");
    if (!discuss) throw new Error("missing Discuss action");
    // Peeking a dismissed finding open still reaches its actions, and the wrapper fade is
    // the only dimming BETWEEN them and the card: the nearest dimmed ancestor of each
    // action IS the finding wrapper itself. Wrap an action in a second `opacity-50` and
    // `closest` returns that inner element instead, so this reddens.
    //
    // What it does NOT cover: a dim expressed any other way — a different opacity step, an
    // inline style, a colour token at reduced alpha. Those are invisible to a class-name
    // assertion, here and anywhere else in this file.
    expect(undo.closest('[class~="opacity-50"]')).toBe(finding);
    expect(discuss.closest('[class~="opacity-50"]')).toBe(finding);
    await user.click(undo);
    await waitFor(() => {
      expect(finding?.getAttribute("data-status")).toBe("open");
      expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
      expect(finding?.className).not.toContain("opacity-50");
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
      lifecycle: "attached",
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

  it("renders a requirement and a message's role + quote", () => {
    const design = renderBoard(designBoard);
    expect(design.container.querySelector("[data-kind=requirement]")).toBeTruthy();
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

  // ── W3 structural restorations (prototype `lens-board.tsx`) ────────────────────

  it("stamps the inferred badge ONLY on a decision the wire marks reconstructed", () => {
    const firstDecision = decisionsBoard.elements.find((el) => el.kind === "decision");
    if (!firstDecision) throw new Error("the decisions fixture carries no decision");
    const inferred: LensBoard = {
      ...decisionsBoard,
      elements: decisionsBoard.elements.map((element) =>
        element.id === firstDecision.id && element.kind === "decision"
          ? { ...element, data: { ...element.data, inferred: true } }
          : element,
      ),
    };
    const marked = renderBoard(inferred);
    // A section renders its children too, so an element appears once loose and once nested.
    // The claim is about WHICH decision wears the badge, so compare element ids, not counts.
    const badged = new Set(
      [...marked.container.querySelectorAll('[data-kind="decision-inferred"]')].map((badge) =>
        badge.closest('[data-kind="decision"]')?.getAttribute("data-element-id"),
      ),
    );
    expect([...badged]).toEqual([firstDecision.id]);
    const badge = marked.container.querySelector('[data-kind="decision-inferred"]');
    expect(badge?.textContent).toBe("inferred");
    // …and its card is the bordered decision, not loose prose.
    expect(badge?.closest('[data-kind="decision"]')?.className).toContain(
      "rounded-md border border-border",
    );
    marked.unmount();

    // The fixture set carries NO `inferred` stamp, and absence is not a mark: a decision
    // read straight off an artifact must never wear the reconstruction warning. Flip the
    // renderer's `inferred === true` to a truthiness check and this stays green — flip it
    // to `inferred !== true` and it reddens, which is the direction that would lie.
    const plain = renderBoard(decisionsBoard);
    expect(plain.container.querySelectorAll('[data-kind="decision-inferred"]')).toHaveLength(0);
    expect(plain.container.querySelector('[data-kind="decision"]')?.className).toContain(
      "rounded-md border border-border",
    );
  });

  /** Re-stamp `f1`'s concurrence data — the one axis these pill tests vary. */
  const withF1Concurrence = (data: Record<string, unknown>): LensBoard => ({
    ...flaggedBoard,
    elements: flaggedBoard.elements.map((element) =>
      element.kind === "finding" && element.id === "f1"
        ? { ...element, data: { ...element.data, ...data } }
        : element,
    ),
  });
  const f1Pill = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(
      '[data-element-id="f1"] [data-kind="finding-concurrence"]',
    );

  it("reads concurrence as ONE pill: green when every seat agreed, verdigris when they split", () => {
    // The fixture's findings carry both seats agreeing, `accord: "concur"` (`flagged.ts:7-11`).
    const both = renderBoard(flaggedBoard);
    const pill = both.container.querySelector<HTMLElement>('[data-kind="finding-concurrence"]');
    expect(pill?.textContent).toBe("concur 2/2");
    expect(pill?.getAttribute("data-concur")).toBe("true");
    expect(pill?.className).toContain("border-green-line");
    expect(pill?.className).toContain("text-green");
    both.unmount();

    // A split: the pipeline stamps `agree: 0` for the seat that answered "no concern"
    // (`server/runtime/lens-pipeline.ts:236-240`), so the pill names who DID raise it and
    // drops out of the evidence register. Same tally shape, different verdict.
    const disagree = renderBoard(
      withF1Concurrence({
        concurrence: [
          { model: "claude", agree: 1, total: 1 },
          { model: "codex", agree: 0, total: 1 },
        ],
        accord: "split",
      }),
    );
    const f1 = f1Pill(disagree.container);
    expect(f1?.textContent).toBe("claude only");
    expect(f1?.getAttribute("data-concur")).toBe("false");
    expect(f1?.className).toContain("border-model-line");
    expect(f1?.className).not.toContain("border-green-line");
  });

  // THE LIE THIS GUARDS: a severity CONFLICT — both seats raised the finding, at
  // materially different severities, so `reconcileFindings` emits `disagree` with NEITHER
  // answer being `NO_CONCERN_ANSWER` — folds to `[{claude,1,1},{codex,1,1}]`, the
  // BYTE-IDENTICAL tally a real concurrence produces. Read from the arithmetic alone the
  // pill went green and said "concur 2/2" over a disagreement. Only `accord` separates them.
  it("does not call a severity conflict a concurrence, though its tallies are identical", () => {
    const conflict = renderBoard(
      withF1Concurrence({
        concurrence: [
          { model: "claude", agree: 1, total: 1 },
          { model: "codex", agree: 1, total: 1 },
        ],
        accord: "conflict",
      }),
    );
    const pill = f1Pill(conflict.container);
    expect(pill?.textContent).toBe("severity split");
    expect(pill?.getAttribute("data-concur")).toBe("false");
    expect(pill?.className).not.toContain("border-green-line");
    expect(pill?.className).toContain("border-model-line");
  });

  // A board drafted before `accord` carries the same ambiguous tallies and no stamp. It
  // may be a concurrence and it may be a conflict; the pill cannot tell, so it states the
  // tally and makes no claim. The one thing it must never do is go green.
  it("states the tally, never a green concurrence, on a board that carries no accord", () => {
    const unstamped = renderBoard(
      withF1Concurrence({
        concurrence: [
          { model: "claude", agree: 1, total: 1 },
          { model: "codex", agree: 1, total: 1 },
        ],
        accord: undefined,
      }),
    );
    const pill = f1Pill(unstamped.container);
    expect(pill?.textContent).toBe("2/2 flagged");
    expect(pill?.textContent).not.toContain("concur");
    expect(pill?.getAttribute("data-concur")).toBe("false");
    expect(pill?.className).not.toContain("border-green-line");
    expect(pill?.className).not.toContain("text-green");
  });

  // A single-harness run (`stampSingleSeatConcurrence`) leaves ONE tally and no accord.
  // There is no second opinion, so there is nothing to split: the verdigris "claude only"
  // register named a disagreement that never happened. It reads as the seat, muted.
  it("reads a single-harness run as the seat's name, not as a split", () => {
    const solo = renderBoard(
      withF1Concurrence({ concurrence: [{ model: "claude", agree: 1, total: 1 }] }),
    );
    const pill = f1Pill(solo.container);
    expect(pill?.textContent).toBe("claude");
    expect(pill?.textContent).not.toContain("only");
    expect(pill?.getAttribute("data-concur")).toBe("false");
    expect(pill?.className).toContain("text-muted-foreground");
    expect(pill?.className).not.toContain("text-model");
    expect(pill?.className).not.toContain("border-green-line");
  });

  // `message.tsx:19` claims a `detached` ask "must remain legible" through the demotion to
  // a caption line. That is a claim about what RENDERS, so it gets executed rather than
  // reasoned about: the word is in the DOM, in its own span, in the danger register — not
  // merely implied by the container's dashed border and 70% opacity, which is the half a
  // reader can miss. Strip the `text-danger`/`font-medium` from the lifecycle span, or drop
  // the span entirely, and this reddens; the container styling alone will not carry it.
  it("keeps a detached ask legible: the caption NAMES the lifecycle, it is not just dimmed", () => {
    const detachedBoard: LensBoard = {
      ...flaggedBoard,
      elements: flaggedBoard.elements.map((element) =>
        element.kind === "message" && element.id === "f2-discuss"
          ? { ...element, data: { ...element.data, lifecycle: "detached" as const } }
          : element,
      ),
    };
    const { container } = renderBoard(detachedBoard);
    const message = container.querySelector<HTMLElement>('[data-kind="message"]');
    expect(message?.getAttribute("data-lifecycle")).toBe("detached");
    const caption = message?.querySelector("p");
    if (!message || !caption) throw new Error("missing detached message caption");
    // The caption names the role AND the lifecycle — the word survives the demotion.
    expect(caption.textContent).toContain("Discuss");
    expect(caption.textContent).toContain("detached");
    const mark = [...caption.querySelectorAll("span")].find((s) => s.textContent === "detached");
    expect(mark?.className).toContain("text-danger");
    expect(mark?.className).toContain("font-medium");
    // …and the quoted words still LEAD: the caption follows the bubble in document order.
    const bubble = message.querySelector('[data-kind="message-bubble"]');
    if (!bubble) throw new Error("missing message bubble");
    expect(bubble.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("renders a noise verdict as a bordered card whose header names the hunk and its judge", () => {
    const { container } = renderBoard(noiseBoard);
    const card = container.querySelector<HTMLElement>(
      '[data-kind="noise_verdict"][data-element-id="nv-barrel"]',
    );
    if (!card) throw new Error("missing nv-barrel verdict");
    expect(card.className).toContain("border-border");
    // The header row is separated from the reason by the card's own rule.
    const header = card.querySelector<HTMLElement>(".border-b");
    expect(header).not.toBeNull();
    // The hunk's own path is the label — the wire carries no group label to use instead.
    expect(header?.textContent).toContain("packages/adapters/src/index.ts");
    // A `deterministic` judge reads "rule" and carries NO Sparkles; only `llm` earns it.
    const judge = card.querySelector<HTMLElement>('[data-kind="noise-judge"]');
    expect(judge?.textContent).toBe("rule");
    expect(judge?.querySelector("svg")).toBeNull();

    const llm: LensBoard = {
      ...noiseBoard,
      elements: noiseBoard.elements.map((element) =>
        element.kind === "noise_verdict" && element.id === "nv-barrel"
          ? { ...element, data: { ...element.data, judge: "llm" as const } }
          : element,
      ),
    };
    const judged = renderBoard(llm);
    const chip = judged.container.querySelector<HTMLElement>(
      '[data-element-id="nv-barrel"] [data-kind="noise-judge"]',
    );
    expect(chip?.textContent).toBe("model judged");
    expect(chip?.querySelector("svg")?.getAttribute("class")).toContain("lucide-sparkles");
  });

  it("renders a message as a railed exchange, the human's quote in a bubble", () => {
    const { container } = renderBoard(flaggedBoard);
    const message = container.querySelector<HTMLElement>('[data-kind="message"]');
    if (!message) throw new Error("missing message element");
    // The rail replaced the bordered ROLE-pill card.
    expect(message.className).toContain("border-l-2");
    expect(message.className).toContain("pl-3");
    // The fixture's message is human-authored (`boards/helpers.ts:188`), so its quote
    // reads as the reviewer's side of the exchange, not as a plain paragraph.
    const bubble = message.querySelector<HTMLElement>('[data-kind="message-bubble"]');
    expect(bubble?.textContent).toContain("connection and token are untouched");
    expect(bubble?.className).toContain("bg-secondary");
    expect(bubble?.className).toContain("rounded-lg");
    // The role survives the restyle — it is what the exchange was FOR.
    expect(message.textContent).toContain("Discuss");
  });
});
