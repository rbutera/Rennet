// @vitest-environment happy-dom
import type { LensSection } from "@rennet/protocol";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRennetStore } from "../store";
import { act, fireEvent, mount } from "../test/dom";
import { flaggedGen2Board } from "../test/fixtures/boards";
import { BoardElementsProvider } from "./kinds/element-context";
import { useRangedThreads } from "./quote-highlight";
import { Section } from "./section";

// ─────────────────────────────────────────────────────────────────────────────
// The board-at-scale proofs (perf audit 2026-08-31 §5 H1/H3). A ~700-claim board is
// the shape these guard: one store write used to re-render and re-derive every element
// on it. Two independent cuts hold that back, and each is measured through a real seam
// rather than asserted structurally:
//
//  1. The quote-thread derivation is memoized on the threads scoped to ONE element, so
//     a write touching another element's thread re-locates nothing here. Counted by the
//     `locate` callback `useRangedThreads` already takes.
//  2. `Section` is `memo`'d, so a parent re-render whose props did not change never
//     reaches it. Counted through `useElement`, which every Section render calls once.
// ─────────────────────────────────────────────────────────────────────────────

const { elementLookups } = vi.hoisted(() => ({ elementLookups: [] as string[] }));

vi.mock("./kinds/element-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./kinds/element-context")>();
  return {
    ...actual,
    useElement: (id: string | undefined) => {
      if (id !== undefined) elementLookups.push(id);
      return actual.useElement(id);
    },
  };
});

const GENERATION = "gen-scale";

/** A stable `locate` (module scope: an inline lambda would be a new dep every render)
 *  that counts every anchor it is asked to resolve. */
const located: string[] = [];
function countingLocate(text: string, anchor: string) {
  located.push(anchor);
  const start = text.indexOf(anchor);
  return start < 0 ? null : { start, end: start + anchor.length };
}

function Probe({ text, elementId }: { readonly text: string; readonly elementId: string }) {
  const ranged = useRangedThreads(text, elementId, countingLocate);
  return <span data-testid={`probe-${elementId}`}>{ranged.length}</span>;
}

function mountProbes() {
  return mount(
    <BoardElementsProvider elements={[]} generation={GENERATION}>
      <Probe text="alpha prose here" elementId="el-a" />
      <Probe text="beta prose here" elementId="el-b" />
    </BoardElementsProvider>,
  );
}

beforeEach(() => {
  located.length = 0;
  elementLookups.length = 0;
  useRennetStore.getState().reviewActions.resetReview();
  useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } });
});

describe("board scale — one store write does not touch every element", () => {
  it("re-derives only the element whose quote threads changed", () => {
    const { getByTestId } = mountProbes();
    const { addQuoteComment, addQuoteReply } = useRennetStore.getState().reviewActions;

    let threadA = "";
    act(() => {
      threadA = addQuoteComment("alpha prose", "why?", "comment", {
        target: "el-a",
        generation: GENERATION,
      });
    });
    expect(getByTestId("probe-el-a").textContent).toBe("1");
    expect(located).toEqual(["alpha prose"]);

    // A thread minted on a DIFFERENT element: `el-b` derives its new range, `el-a` — which
    // re-renders, because the whole `quoteThreads` record was replaced — derives nothing.
    located.length = 0;
    act(() =>
      addQuoteComment("beta prose", "why?", "comment", {
        target: "el-b",
        generation: GENERATION,
      }),
    );
    expect(getByTestId("probe-el-b").textContent).toBe("1");
    expect(located).toEqual(["beta prose"]);

    // …and the memo is not stale: a reply INTO el-a's own thread does re-derive it, so the
    // popover behind the highlight can never be showing an older exchange.
    located.length = 0;
    act(() => addQuoteReply(threadA, "user", "because"));
    expect(located).toEqual(["alpha prose"]);

    // A write to an unrelated slice does not reach the derivation at all.
    located.length = 0;
    act(() => useRennetStore.getState().viewedDeltaActions.markDeltaViewed("board-x", "sec-x"));
    expect(located).toEqual([]);
  });

  it("does not re-render a section whose props did not change", () => {
    const entry = flaggedGen2Board.sections.find((s) => s.ref === "g2-gen1") as LensSection;
    function Harness() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            tick {tick}
          </button>
          <BoardElementsProvider
            elements={flaggedGen2Board.elements}
            boardId={flaggedGen2Board.boardId}
            generation={GENERATION}
          >
            <Section entry={entry} />
          </BoardElementsProvider>
        </>
      );
    }
    const { getByText } = mount(<Harness />);
    expect(elementLookups).toContain("g2-gen1");

    elementLookups.length = 0;
    fireEvent.click(getByText(/tick/));
    expect(getByText(/tick 1/)).toBeTruthy(); // the parent really did re-render
    expect(elementLookups).toEqual([]); // …and the section did not
  });
});
