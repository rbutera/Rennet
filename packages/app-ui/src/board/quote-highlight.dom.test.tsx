// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { mount } from "../test/dom";
import { designBoard, designGen0Board } from "../test/fixtures/boards";
import { MemoryBridge } from "../test/memory-bridge";
import { BoardElement, BoardElementsProvider } from "./kinds";
import { QuoteHighlightLayer } from "./quote-highlight";

// Cluster 5 (durable quote highlights). Threads live on the real `review` slice; the
// layer reads them and highlights the anchored span over prose — durable because it is
// store-driven, not local. Mounted over an empty MemoryBridge (RichText's citation seam
// is unbound; the test prose carries no citations, so no span read fires).

const PROSE =
  "The adapter authenticates with the user's subscription and costs nothing per token.\n\nA separate paragraph with untouched prose.";

const EL = "p1";
const { addQuoteComment, setFocusedThread, resetReview } = useRennetStore.getState().reviewActions;

beforeEach(() => resetReview());

/** Seed a scoped thread on the test element (target=EL, the default "" generation the
 *  bare layer reads) — the identity every durable highlight now requires (finding 2). */
function seed(anchor: string, text: string, kind?: "comment" | "explain") {
  return addQuoteComment(anchor, text, kind, { target: EL, generation: "" });
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
    expect(container.querySelector("[data-quote-highlight]")).toBeNull();
    expect(container.textContent).toContain("costs nothing per token");
  });

  it("an anchored quoteThread renders as a durable highlight over the span", () => {
    seed("costs nothing per token", "Is this actually free?");
    const { container } = render();
    const hl = container.querySelector("[data-quote-highlight]");
    expect(hl).toBeTruthy();
    expect(hl?.textContent).toBe("costs nothing per token");
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

  it("the selection-toolbar hand-off: focusing a fresh thread opens its popover, no click", () => {
    // The toolbar mints a thread then calls setFocusedThread(id) — the highlight opens
    // straight into the exchange and releases the focus.
    const id = seed("costs nothing per token", "why free?");
    setFocusedThread(id);
    const { container } = render();
    expect(container.textContent).toContain("why free?");
    expect(container.querySelector(`[data-thread-id="${id}"]`)).toBeTruthy();
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
