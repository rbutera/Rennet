// @vitest-environment happy-dom
//
// `useAppWorking` is the ONE fact the frame's sphere renders, and it has two sources.
// A hook that read only one would leave the chrome resting while the other ran — so
// each source is driven on its own here (proving it alone is sufficient), and both are
// then cleared (proving neither is a constant).
import { afterEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, mount } from "../test/dom";
import { useReviewActivityState } from "./review-activity-state";
import { useAppWorking } from "./use-app-working";

function Probe() {
  return <span data-testid="working">{String(useAppWorking())}</span>;
}

const working = (r: { getByTestId: (id: string) => HTMLElement }) =>
  r.getByTestId("working").textContent;

afterEach(() => {
  cleanup();
  act(() => {
    useReviewActivityState.setState({ bySession: {} });
    useRennetStore.getState().runActions.resetRun();
  });
});

describe("useAppWorking", () => {
  it("is false when nothing is running", () => {
    expect(working(mount(<Probe />))).toBe("false");
  });

  it("reads a running session from the review-activity projection", () => {
    const r = mount(<Probe />);
    act(() =>
      useReviewActivityState.setState({ bySession: { s1: { kind: "running", runId: "r1" } } }),
    );
    expect(working(r)).toBe("true");
    // A session that SETTLED is not work in flight — the projection keeps the row.
    act(() => useReviewActivityState.setState({ bySession: { s1: { kind: "complete", at: 1 } } }));
    expect(working(r)).toBe("false");
  });

  it("reads a live round from the run store, with no session activity at all", () => {
    const r = mount(<Probe />);
    expect(working(r)).toBe("false");
    act(() => useRennetStore.getState().runActions.setRoundProgress(0.4));
    expect(working(r)).toBe("true");
    act(() => useRennetStore.getState().runActions.setRoundProgress(null));
    expect(working(r)).toBe("false");
  });

  it("stays working while EITHER source still is", () => {
    const r = mount(<Probe />);
    act(() => {
      useReviewActivityState.setState({ bySession: { s1: { kind: "running", runId: "r1" } } });
      useRennetStore.getState().runActions.setRoundProgress(0.1);
    });
    expect(working(r)).toBe("true");
    // Dropping one source does not settle the chrome while the other runs.
    act(() => useReviewActivityState.setState({ bySession: {} }));
    expect(working(r)).toBe("true");
    act(() => useRennetStore.getState().runActions.setRoundProgress(null));
    expect(working(r)).toBe("false");
  });
});
