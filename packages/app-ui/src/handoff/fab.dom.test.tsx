// @vitest-environment happy-dom
//
// The exit FAB (C08 cluster 2, Objective clause 1, autopsy S8). The load-bearing claim is
// the inversion: the pip count is DERIVED (`selectExitPipCount`) so it survives navigation
// and never clears on open, while the pop rides the `signal` slice's land GESTURE — never
// the count — so a static re-render or a seeded stage does not animate.
import { afterEach, describe, expect, it } from "vitest";
import { BoardElement, BoardElementsProvider } from "../board/kinds";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { act, cleanup, mount, waitFor } from "../test/dom";
import { flaggedBoard } from "../test/fixtures/boards";
import { MemoryBridge } from "../test/memory-bridge";
import { ExitFab } from "./fab";

const noop = () => undefined;
const store = () => useRennetStore.getState();
function stage(anchor: string) {
  act(() => store().reviewActions.stageAsk({ id: anchor, anchor, type: "comment", body: "b" }));
}
const pip = (root: ParentNode) => root.querySelector('[data-pip="exit"]');

afterEach(() => {
  cleanup();
  store().reviewActions.resetReview();
  store().signalActions.resetSignal();
});

describe("ExitFab", () => {
  it("shows the derived pip count, unchanged by a re-render (navigation)", () => {
    stage("a");
    stage("b");
    const r = mount(<ExitFab mode="teammate-pr" open={false} onToggle={noop} />);
    expect(pip(r.container)?.textContent).toBe("2");
    // The count is derived, not stored — a static re-render (a navigation) preserves it.
    r.rerender(<ExitFab mode="teammate-pr" open={false} onToggle={noop} />);
    expect(pip(r.container)?.textContent).toBe("2");
  });

  it("decrements when a stage is undone", () => {
    stage("a");
    stage("b");
    const r = mount(<ExitFab mode="teammate-pr" open={false} onToggle={noop} />);
    expect(pip(r.container)?.textContent).toBe("2");
    act(() => store().reviewActions.unstageAsk("a"));
    expect(pip(r.container)?.textContent).toBe("1");
  });

  it("keeps the count when the hand-off opens (opening never clears it)", () => {
    stage("a");
    const r = mount(<ExitFab mode="teammate-pr" open={false} onToggle={noop} />);
    expect(pip(r.container)?.textContent).toBe("1");
    r.rerender(<ExitFab mode="teammate-pr" open={true} onToggle={noop} />);
    expect(pip(r.container)?.textContent).toBe("1");
  });

  it("carries the count in the accessible name, not inline in the visible text (R50)", () => {
    stage("a");
    stage("b");
    const r = mount(<ExitFab mode="teammate-pr" open={false} onToggle={noop} />);
    const btn = r.getByRole("button");
    expect(btn.getAttribute("aria-label")).toContain("2");
    // The pip is decorative (aria-hidden); the count reaches assistive tech via the name.
    expect(pip(r.container)?.getAttribute("aria-hidden")).toBe("true");
  });

  it("pops on a land (a gesture), never on a static re-render", () => {
    stage("a");
    const r = mount(<ExitFab mode="teammate-pr" open={false} onToggle={noop} />);
    const btn = r.getByRole("button");
    expect(pip(r.container)?.getAttribute("data-pop")).toBeNull(); // mount is not a gesture

    // A stage that changes the count WITHOUT a launch (seeding, navigation) never pops.
    stage("b");
    r.rerender(<ExitFab mode="teammate-pr" open={false} onToggle={noop} />);
    expect(pip(r.container)?.getAttribute("data-pop")).toBeNull();

    // A real gesture: launch → the FAB lands the in-flight pip → the pop rides that landing.
    act(() => btn.focus());
    act(() => store().signalActions.launch(1));
    expect(pip(r.container)?.getAttribute("data-pop")).toBe("true");
  });

  it("a REAL staging click drives the flight through the wired batcher (cluster 2, not a synthetic launch)", async () => {
    // The batcher was orphaned (no production caller); it is now wired at the real staging sites.
    // Mount an actual staging control (the board finding's Request-This-Change) beside the FAB — they
    // share the singleton store — and click it. The click fires `useFlightBatcher().signal()`, which
    // (after its ~80ms window) launches: the signal slice registers the flight. No test touches
    // `signalActions.launch` — a genuine interaction drives it end to end.
    const r = mount(
      <BridgeProvider bridge={new MemoryBridge({})}>
        <BoardElementsProvider elements={flaggedBoard.elements}>
          {[...new Map(flaggedBoard.elements.map((el) => [el.id, el])).values()].map((el) => (
            <BoardElement key={el.id} element={el} />
          ))}
        </BoardElementsProvider>
        <ExitFab mode="teammate-pr" open={false} onToggle={noop} />
      </BridgeProvider>,
    );
    const [request] = r.getAllByText("Request This Change");
    expect(store().signal.inFlight + store().signal.landed).toBe(0); // no flight before the click
    if (request) await r.user.click(request);
    // The ask staged AND the wired batcher launched a flight (in-flight or already landed).
    expect(Object.keys(store().review.stagedAsks).length).toBe(1);
    await waitFor(() => expect(store().signal.inFlight + store().signal.landed).toBeGreaterThan(0));
  });

  it("labels by target — Write Review on a teammate PR, Continue on your own branch", () => {
    const t = mount(<ExitFab mode="teammate-pr" open={false} onToggle={noop} />);
    expect(t.getByRole("button").textContent).toContain("Write Review");
    cleanup();
    const o = mount(<ExitFab mode="own-branch" open={false} onToggle={noop} />);
    expect(o.getByRole("button").textContent).toContain("Continue");
  });

  it("renders no FAB for a retrospective review (no exit, law 10)", () => {
    stage("a");
    const r = mount(<ExitFab mode="retrospective" open={false} onToggle={noop} />);
    expect(r.container.querySelector("button")).toBeNull();
  });

  it("yields (inert + faded) while the hand-off is open (R49)", () => {
    const r = mount(<ExitFab mode="teammate-pr" open={true} onToggle={noop} />);
    const btn = r.getByRole("button");
    expect(btn.getAttribute("data-open")).toBe("true");
    expect(btn.className).toContain("opacity-0");
    expect(btn.className).toContain("pointer-events-none");
  });

  it("toggles the hand-off on click", async () => {
    let toggled = 0;
    const r = mount(<ExitFab mode="teammate-pr" open={false} onToggle={() => toggled++} />);
    await r.user.click(r.getByRole("button"));
    expect(toggled).toBe(1);
  });
});
