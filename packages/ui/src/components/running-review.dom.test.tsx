// @vitest-environment happy-dom
//
// The live running-review state (critique P1-A). The old static text card read
// identically whether the engine was working or hung; this state must show visible
// proof of life — an indeterminate track AND a live elapsed clock — with NO fake
// stage and NO cancel (the engine emits neither). These assert the honest signals
// render and the clock actually advances.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, mount } from "../test/dom";
import { formatElapsed, RunningReview } from "./running-review";

describe("formatElapsed", () => {
  it("shows bare seconds under a minute and m/ss beyond", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(3)).toBe("3s");
    expect(formatElapsed(59)).toBe("59s");
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(75)).toBe("1m 15s");
    expect(formatElapsed(600)).toBe("10m 00s");
  });
});

describe("RunningReview (critique P1-A)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the indeterminate track and an elapsed clock, and keeps the announced heading", () => {
    const { container } = mount(<RunningReview />);
    // Proof of motion: the indeterminate track (never a percentage/stage).
    expect(container.querySelector('[data-testid="running-review-track"]')).not.toBeNull();
    // The live region announces "working", not the ticking clock (clock is aria-hidden).
    const region = container.querySelector(".canvas-primer");
    expect(region?.getAttribute("role")).toBe("status");
    expect(container.textContent).toContain("Running the review");
    const elapsed = container.querySelector('[data-testid="running-review-elapsed"]');
    expect(elapsed?.getAttribute("aria-hidden")).toBe("true");
    expect(elapsed?.textContent).toBe("0s elapsed");
  });

  it("advances the elapsed clock as the run continues", () => {
    vi.useFakeTimers();
    const { container } = mount(<RunningReview />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.querySelector('[data-testid="running-review-elapsed"]')?.textContent).toBe(
      "3s elapsed",
    );
  });

  it("offers no cancel control — there is nothing to abort", () => {
    const { container } = mount(<RunningReview />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("adds one quiet stalled-run line past ~120s, and not before", () => {
    vi.useFakeTimers();
    const { container } = mount(<RunningReview />);
    // Nothing at the start — a normal run must not read as stalled.
    expect(container.querySelector('[data-testid="running-review-stalled"]')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(119_000);
    });
    expect(container.querySelector('[data-testid="running-review-stalled"]')).toBeNull();
    // Past the threshold the honest "still working" line appears (elapsed-based only).
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const stalled = container.querySelector('[data-testid="running-review-stalled"]');
    expect(stalled).not.toBeNull();
    expect(stalled?.textContent).toContain("Still working");
  });
});
