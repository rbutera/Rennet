// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import {
  type AnchoredAskInput,
  AnchoredAskProvider,
  ProseSelectionLayer,
  ReviewAnchoredAskProvider,
} from "../review";
import { useRennetStore } from "../store";
import { act, mount, waitFor } from "../test/dom";
import { designBoard, designGen0Board, prose } from "../test/fixtures/boards";
import { type CommandHandler, MemoryBridge } from "../test/memory-bridge";
import { BoardElement, BoardElementsProvider } from "./kinds";
import { InlineQuoteHighlight, QuoteHighlightLayer } from "./quote-highlight";

// Cluster 5 (durable quote highlights). Threads live on the real `review` slice; the
// layer reads them and highlights the anchored span over prose — durable because it is
// store-driven, not local. Mounted over an empty MemoryBridge: the test prose carries no
// citations, so no span read fires and no `patchset.readSpan` handler is needed.

const PROSE =
  "The adapter authenticates with the user's subscription and costs nothing per token.\n\nA separate paragraph with untouched prose.";

const EL = "p1";
const { addQuoteComment, resetReview } = useRennetStore.getState().reviewActions;

beforeEach(() => resetReview());

/** Seed a scoped thread on the test element (target=EL, the default "" generation the
 *  bare layer reads) — the identity every durable highlight now requires (finding 2). */
function seed(anchor: string, text: string, kind?: "comment" | "explain") {
  return addQuoteComment(anchor, text, kind, { target: EL, generation: "" });
}

/** Select the contents of `el` and release inside it — the real anchoring gesture the
 *  ProseSelectionLayer listens for (mirrors review/selection-toolbar.dom.test). */
function selectAndRelease(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

function render(text = PROSE) {
  return mount(
    <BridgeProvider bridge={new MemoryBridge({})}>
      <QuoteHighlightLayer
        text={text}
        elementId={EL}
        patchsetId="ps-1"
        paragraphClassName="prose-p"
      />
    </BridgeProvider>,
  );
}

describe("QuoteHighlightLayer — durable quote highlights", () => {
  it("no thread anchored here → renders plain prose, no highlight", () => {
    const { container } = render();
    expect(container.querySelector(`[data-quote-target="${EL}"]`)).toBeTruthy();
    expect(container.querySelector("[data-quote-highlight]")).toBeNull();
    expect(container.textContent).toContain("costs nothing per token");
  });

  it("renders an inline target and opens its thread without activating its parent control", async () => {
    const id = seed("durable title", "Keep the title thread reachable.");
    let activations = 0;
    const { container, user } = mount(
      <InlineQuoteHighlight
        text="A durable title"
        elementId={EL}
        onActivate={() => {
          activations += 1;
        }}
        ariaLabel="Toggle section"
      />,
    );
    const target = container.querySelector<HTMLElement>(`[data-quote-target="${EL}"]`);
    const highlight = target?.querySelector<HTMLElement>("[data-quote-highlight]");

    expect(target?.textContent).toBe("A durable title");
    expect(highlight?.textContent).toBe("durable title");
    if (highlight) await user.click(highlight);
    expect(activations).toBe(0);
    expect(container.querySelector(`[data-thread-id="${id}"]`)).toBeTruthy();

    if (target) await user.click(target);
    expect(activations).toBe(1);
  });

  it("an anchored quoteThread renders as a durable highlight over the span", () => {
    seed("costs nothing per token", "Is this actually free?");
    const { container } = render();
    const hl = container.querySelector("[data-quote-highlight]");
    expect(hl).toBeTruthy();
    expect(hl?.textContent).toBe("costs nothing per token");
  });

  it("does not paint a detached thread on its stale generation", () => {
    const id = seed("costs nothing per token", "Is this actually free?");
    const state = useRennetStore.getState();
    const thread = state.review.quoteThreads[id];
    expect(thread).toBeTruthy();
    if (!thread || thread.target === undefined || thread.generation === undefined) return;
    useRennetStore.setState({
      review: {
        ...state.review,
        quoteThreads: { [id]: { ...thread, lifecycle: "detached" } },
      },
    });

    const { container } = render();
    expect(container.querySelector("[data-quote-highlight]")).toBeNull();
    expect(container.textContent).toContain("costs nothing per token");
  });

  it("maps displayed backtick text to the raw token and keeps the code node", () => {
    const raw = "Call `decompose()` before dispatch.";
    seed("decompose()", "Why this call?");
    const { container } = render(raw);
    const hl = container.querySelector<HTMLElement>("[data-quote-highlight]");

    expect(hl?.textContent).toBe("decompose()");
    expect(hl?.querySelector("code")?.textContent).toBe("decompose()");
    expect(
      container.querySelector("[data-rich-text-raw]")?.getAttribute("data-rich-text-raw"),
    ).toBe(raw);
  });

  it("renders a mapped raw citation as a live citation chip", () => {
    const raw = "See packages/core/worker.ts:42-43 before dispatch.";
    seed("packages/core/worker.ts:42-43", "Show the cited code.");
    const { container } = render(raw);
    const hl = container.querySelector<HTMLElement>("[data-quote-highlight]");
    const chip = hl?.querySelector<HTMLButtonElement>("button");

    expect(hl?.textContent).toBe("worker.ts:42-43");
    expect(chip?.textContent).toBe("worker.ts:42-43");
    expect(chip?.title).toBe("packages/core/worker.ts:42-43");
  });

  it("keeps bold tokenization inside a highlighted quote", () => {
    seed("important", "Why is this important?");
    const { container } = render("This is **important** context.");
    const hl = container.querySelector<HTMLElement>("[data-quote-highlight]");

    expect(hl?.querySelector("strong")?.textContent).toBe("important");
  });

  it("does not guess when the displayed quote appears twice", () => {
    seed("same", "Which occurrence?");
    const { container } = render("`same` and same");

    expect(container.querySelector("[data-quote-highlight]")).toBeNull();
  });

  it("clicking a highlight opens the exchange; a reply appends via addQuoteReply", async () => {
    const id = seed("costs nothing per token", "Is this actually free?");
    const { container, user } = render();
    const hl = container.querySelector<HTMLElement>("[data-quote-highlight]");
    expect(hl).toBeTruthy();
    if (hl) await user.click(hl);
    expect(container.textContent).toContain("Is this actually free?");

    const box = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(box).toBeTruthy();
    if (box) {
      await user.type(box, "No — it rides the subscription.");
      await user.keyboard("{Enter}");
    }
    const thread = useRennetStore.getState().review.quoteThreads[id];
    expect(thread?.messages.map((m) => m.text)).toEqual([
      "Is this actually free?",
      "No — it rides the subscription.",
    ]);
    expect(container.textContent).toContain("No — it rides the subscription.");
  });

  it("Enter sends one real follow-up on the existing anchored thread", async () => {
    const id = seed("costs nothing per token", "Explain this passage.", "explain");
    const sent: AnchoredAskInput[] = [];
    const { container, user } = mount(
      <BridgeProvider bridge={new MemoryBridge({})}>
        <AnchoredAskProvider
          value={async (input) => {
            sent.push(input);
          }}
        >
          <QuoteHighlightLayer text={PROSE} elementId={EL} patchsetId="ps-1" />
        </AnchoredAskProvider>
      </BridgeProvider>,
    );
    const highlight = container.querySelector<HTMLElement>("[data-quote-highlight]");
    if (highlight) await user.click(highlight);
    const box = container.querySelector<HTMLTextAreaElement>("textarea");
    if (box) {
      await user.type(box, "Why exactly?");
      await user.keyboard("{Enter}");
    }

    expect(sent).toEqual([
      {
        threadId: id,
        question: "Why exactly?",
        excerpt: "costs nothing per token",
        target: EL,
        generation: "",
      },
    ]);
  });

  it("overlapping anchors stay reachable — the covered span carries both threads", async () => {
    const a = seed("authenticates with the user's", "who authenticates?");
    const b = seed("user's subscription", "which subscription?");
    const { container, user } = render();
    // The overlap segment ("user's") is covered by both threads.
    const stacked = container.querySelector<HTMLElement>(
      '[data-quote-highlight][data-thread-count="2"]',
    );
    expect(stacked).toBeTruthy();
    if (stacked) await user.click(stacked);
    expect(container.querySelector(`[data-thread-id="${a}"]`)).toBeTruthy();
    expect(container.querySelector(`[data-thread-id="${b}"]`)).toBeTruthy();
  });

  it("an Explain thread reads distinctly and stages no ask (never an exit)", async () => {
    seed("costs nothing per token", "Explain this passage.", "explain");
    const { container, user } = render();
    const hl = container.querySelector<HTMLElement>('[data-quote-highlight][data-explain="true"]');
    expect(hl).toBeTruthy();
    if (hl) await user.click(hl);
    expect(container.querySelector('[data-thread-kind="explain"]')).toBeTruthy();
    // Explain is a question to the orchestrator: it never mints a staged ask.
    expect(Object.keys(useRennetStore.getState().review.stagedAsks)).toHaveLength(0);
  });

  it("a REAL selection → toolbar → highlight round-trip mints a scoped thread (finding 7)", async () => {
    // Not a seeded store: select real board prose, drive the toolbar's Comment verb, and
    // prove the minted thread carries the DOM-discovered (target, generation) scope and
    // renders as a durable highlight on THIS element. Also exercises the focus hand-off —
    // Comment calls setFocusedThread(id), which opens the popover with no extra click.
    const proseEl = prose("p-sel", "A quotable board sentence.");
    const { container, getByText, getByPlaceholderText, user } = mount(
      <BridgeProvider bridge={new MemoryBridge({})}>
        <BoardElementsProvider elements={[proseEl]} generation="gen1" boardId="b1">
          <ProseSelectionLayer>
            {/* data-generation on the ancestor is what scopeOfRange reads for the mint. */}
            <article data-generation="gen1">
              <BoardElement element={proseEl} />
            </article>
          </ProseSelectionLayer>
        </BoardElementsProvider>
      </BridgeProvider>,
    );
    expect(container.querySelector("[data-quote-highlight]")).toBeNull();

    selectAndRelease(getByText("A quotable board sentence."));
    await user.click(getByText("Comment"));
    await user.type(getByPlaceholderText("Ask a question or leave a comment…"), "which sentence?");
    await user.click(getByText("Save"));

    const threads = Object.values(useRennetStore.getState().review.quoteThreads);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.target).toBe("p-sel");
    expect(threads[0]?.generation).toBe("gen1");
    // Scoped identity ⇒ the highlight renders on this element, and the focus hand-off
    // opened its exchange without a further click.
    const hl = container.querySelector<HTMLElement>("[data-kind=prose] [data-quote-highlight]");
    expect(hl?.textContent).toBe("A quotable board sentence.");
    expect(container.textContent).toContain("which sentence?");
    expect(useRennetStore.getState().review.focusedThreadId).toBeNull();
  });

  it("highlights through the real board pipeline — a prose element on a fixture board", async () => {
    // Not the layer in isolation: dispatch a real fixture prose element through
    // BoardElement → ProseElement → QuoteHighlightLayer, proving the highlight surfaces
    // wherever board prose renders.
    const proseEl = designBoard.elements.find((el) => el.id === "change-why");
    expect(proseEl).toBeTruthy();
    if (!proseEl) return;
    // The thread carries the protocol-shaped identity: target=the element, generation=the
    // board's — so it lands on THIS element in THIS generation and nowhere else (finding 2).
    const id = addQuoteComment("Renewal was silent", "why was it silent?", "comment", {
      target: "change-why",
      generation: designBoard.generation,
    });
    const { container, user } = mount(
      <BridgeProvider bridge={new MemoryBridge({})}>
        <BoardElementsProvider elements={designBoard.elements} generation={designBoard.generation}>
          <BoardElement element={proseEl} />
        </BoardElementsProvider>
      </BridgeProvider>,
    );
    const hl = container.querySelector<HTMLElement>("[data-kind=prose] [data-quote-highlight]");
    expect(hl?.textContent).toBe("Renewal was silent");
    if (hl) await user.click(hl);
    expect(container.querySelector(`[data-thread-id="${id}"]`)).toBeTruthy();
    expect(container.textContent).toContain("why was it silent?");
  });

  it("does NOT fabricate the highlight on the same element id in another generation (finding 2)", () => {
    // "Renewal was silent" and the element id `change-why` BOTH repeat in gen0 and gen1.
    // A thread scoped to gen1 must not paint the gen0 board's identical span — the exact
    // cross-generation fabrication finding 2 kills. Pre-fix (bare text.includes) this
    // highlighted; scoped by (element, generation) it stays plain.
    addQuoteComment("Renewal was silent", "why?", "comment", {
      target: "change-why",
      generation: "gen1",
    });
    const gen0Prose = designGen0Board.elements.find((el) => el.id === "change-why");
    expect(gen0Prose).toBeTruthy();
    if (!gen0Prose) return;
    const { container } = mount(
      <BridgeProvider bridge={new MemoryBridge({})}>
        <BoardElementsProvider
          elements={designGen0Board.elements}
          generation={designGen0Board.generation}
        >
          <BoardElement element={gen0Prose} />
        </BoardElementsProvider>
      </BridgeProvider>,
    );
    expect(container.querySelector("[data-quote-highlight]")).toBeNull();
    expect(container.textContent).toContain("Renewal was silent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #888 — an anchored ask that does not go out must say so on the thread that asked.
//
// The defect these cover is NOT "an error was swallowed". It is that the reviewer's own
// question was used as false evidence of delivery. Every anchored-ask call site appends the
// message to the thread and clears the draft box BEFORE the send — `quote-highlight`'s Enter
// handler here, `discussFinding` in board/kinds/finding, `startThread` in
// review/selection-toolbar — so a failed send leaves the question sitting in the exchange
// looking exactly like one that landed. Rai's own `~/.rennet/asks/…json` is that record: one
// `quote-open`, `kind: "explain"`, one user message, no reply, no error, ever.
//
// So these assert what the REVIEWER SEES, not that a handler ran: the alert is in the DOM,
// it carries the daemon's own sentence, and the question is still there beside it.
//
// The whole stack is real — the real `ReviewAnchoredAskProvider`, the real `useMutation`,
// the real store, the real popover. Only the daemon is a stub, and it is a stub that THROWS
// or REPORTS rather than a MISSING handler: a missing handler makes MemoryBridge reject with
// its own "no handler" text, which asserts a fact about the harness instead of the product
// (memory-bridge.ts says so at length, having watched four green tests sit on top of an
// unbound dispatch).
// ─────────────────────────────────────────────────────────────────────────────
describe("an anchored ask that does not go out (#888)", () => {
  /** Mount the real provider over a daemon stub, with one seeded thread on the prose. */
  function renderWithAsk(handler: CommandHandler<"chat.t3Send">) {
    const id = seed("costs nothing per token", "Is this actually free?");
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge({ "chat.t3Send": handler })}>
        <ReviewAnchoredAskProvider reviewId="review-1">
          <QuoteHighlightLayer
            text={PROSE}
            elementId={EL}
            patchsetId="ps-1"
            paragraphClassName="prose-p"
          />
        </ReviewAnchoredAskProvider>
      </BridgeProvider>,
    );
    return { id, view };
  }

  /** Open the thread (if the click toggled it shut, it is already open) and send a reply —
   *  the reviewer's actual gesture, not a direct store write. */
  async function reply(view: ReturnType<typeof mount>, text: string) {
    if (view.container.querySelector("textarea") === null) {
      const highlight = view.container.querySelector<HTMLElement>("[data-quote-highlight]");
      if (!highlight) throw new Error("no highlight to open");
      await view.user.click(highlight);
    }
    const box = view.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!box) throw new Error("no reply box");
    await view.user.click(box);
    await view.user.keyboard(`${text}{Enter}`);
  }

  const SIDECAR_DOWN = "T3 sidecar unavailable: the vendored T3 Code server bundle is not built";

  it("says the question was not sent, in the daemon's own words, when the send is refused", async () => {
    const { id, view } = renderWithAsk(() => {
      throw new Error(SIDECAR_DOWN);
    });

    await reply(view, "Why is this free?");

    // What the reviewer sees. `role="alert"` because a dropped question is not a muted
    // notice — the `t3-chat-*` slots are notices and that is exactly why the dock looked
    // healthy while the ask went nowhere.
    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("This question was not sent.");
    // The daemon's sentence, verbatim. "Sidecar not built" and "spawn EBADF" are different
    // problems and only one of them is worth retrying; a generic line would hide which.
    expect(alert.textContent).toContain(SIDECAR_DOWN);
    // And it is ON THE THREAD THAT ASKED, not in a corner.
    expect(view.container.querySelector(`[data-thread-id="${id}"]`)?.textContent).toContain(
      "This question was not sent.",
    );
    // The question stays: they did ask it. This is the half that makes the alert load-bearing
    // rather than decorative — without it the reviewer reads their own words as delivered.
    expect(useRennetStore.getState().review.quoteThreads[id]?.messages.at(-1)).toEqual({
      author: "user",
      text: "Why is this free?",
    });
  });

  it("says so for a REPORTED unavailable outcome too, not only a rejection", async () => {
    // The daemon reached a verdict and it was "this did not go out" (#872's shape, extended
    // to `chat.t3Send`). It RESOLVES, so a `catch`-only surface would miss it entirely and
    // the reviewer would be back to silence — which is why this case is its own test.
    const { view } = renderWithAsk(() => ({
      status: "unavailable",
      reason: "no bound workspace for review-1",
    }));

    await reply(view, "Explain this passage.");

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("This question was not sent.");
    expect(alert.textContent).toContain("no bound workspace for review-1");
  });

  it("clears the failure when a later ask on the same thread goes through", async () => {
    let refuse = true;
    const { view } = renderWithAsk(() => {
      if (refuse) throw new Error(SIDECAR_DOWN);
      return { status: "sent", threadId: "t3-thread-1" };
    });

    await reply(view, "First try.");
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());

    refuse = false;
    await reply(view, "Second try.");

    // A stale failure beside a question that DID go is the same lie pointing the other way.
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  });

  it("does not leave a failure behind on a thread the reviewer closed", () => {
    const { id } = renderWithAsk(() => ({ status: "sent", threadId: "t3-thread-1" }));
    act(() => useRennetStore.getState().reviewActions.setQuoteAskFailure(id, SIDECAR_DOWN));
    expect(useRennetStore.getState().review.quoteAskFailures[id]).toBe(SIDECAR_DOWN);
    act(() => useRennetStore.getState().reviewActions.removeQuoteComment(id));
    expect(useRennetStore.getState().review.quoteAskFailures[id]).toBeUndefined();
  });
});
