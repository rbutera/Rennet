// @vitest-environment happy-dom
//
// The exit FAB (C08 cluster 2, Objective clause 1, autopsy S8). The load-bearing claim is
// the inversion: the pip count is DERIVED (`selectExitPipCount`) so it survives navigation
// and never clears on open, while the pop rides the `signal` slice's land GESTURE — never
// the count — so a static re-render or a seeded stage does not animate.
import { afterEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, mount } from "../test/dom";
import { ExitFab } from "./fab";

const noop = () => undefined;
const store = () => useRennetStore.getState();
function stage(anchor: string) {
  act(() => store().reviewActions.stageAsk({ anchor, type: "comment", body: "b" }));
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
