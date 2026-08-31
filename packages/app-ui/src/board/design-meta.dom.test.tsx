// @vitest-environment happy-dom
import type { MouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followBoardAnchor } from "./design-meta";

// ─────────────────────────────────────────────────────────────────────────────
// The anchor jump waits out the fold it opened.
//
// `Collapse` animates `grid-template-rows` from 0fr over `COLLAPSE_MS`, so for that window
// the section it just opened is still growing: a `scrollIntoView` one frame after the
// toggle computes its offset against a nearly-zero-height section and lands SHORT.
//
// STATED LIMIT: happy-dom runs no layout and no CSS transitions, so nothing here can
// observe the geometry that is the actual bug. What these tests pin is WHEN the scroll is
// issued relative to the fold's own duration, and that the target is re-resolved at that
// moment rather than captured at click time. The geometry claim rests on the timing.
// ─────────────────────────────────────────────────────────────────────────────

const clickEvent = () => ({ preventDefault: () => undefined }) as MouseEvent<HTMLAnchorElement>;

function reducedMotion(matches: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches, media: query }) as MediaQueryList,
  );
}

/** Give `#target` a recording `scrollIntoView` and return the log. */
function recordScrollsOn(id: string, into: unknown[]): void {
  const element = document.getElementById(id);
  if (element) element.scrollIntoView = (options?: unknown) => into.push(options);
}

/**
 * A folded section whose toggle mounts the body — SYNCHRONOUSLY, because `Collapse` mounts
 * its children in the same commit that flips the row track and React flushes a discrete
 * click before returning to the event loop. The section then animates open for 200ms with
 * the target already in the document; that is the whole trap.
 */
function foldedSection(onOpen: () => void): void {
  document.body.innerHTML = `
    <section id="sec" data-kind="board-section" data-open="false">
      <h2><button type="button" aria-expanded="false">Section</button></h2>
    </section>`;
  document.querySelector("button")?.addEventListener("click", () => {
    const section = document.getElementById("sec");
    section?.setAttribute("data-open", "true");
    const target = document.createElement("div");
    target.id = "target";
    section?.append(target);
    onOpen();
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("followBoardAnchor", () => {
  it("holds the scroll until the fold's animation is over", () => {
    reducedMotion(false);
    const scrolls: unknown[] = [];
    foldedSection(() => recordScrollsOn("target", scrolls));

    followBoardAnchor(clickEvent(), "target", "sec");
    expect(document.getElementById("target")).not.toBeNull(); // mounted, but 0fr tall
    vi.advanceTimersByTime(16);
    // A frame in — where the jump used to fire — the grid track has barely left 0fr.
    // CONTROL: put `requestAnimationFrame(scroll)` back and this line reddens.
    expect(scrolls).toEqual([]);
    vi.advanceTimersByTime(183); // 199ms: one tick short of the fold's duration
    expect(scrolls).toEqual([]);

    // COLLAPSE_MS exactly: the track has reached 1fr, so the offset is the real one.
    vi.advanceTimersByTime(1);
    expect(scrolls).toEqual([{ behavior: "smooth", block: "start" }]);
  });

  it("re-resolves the target at scroll time, not at click time", () => {
    reducedMotion(false);
    const first: unknown[] = [];
    const second: unknown[] = [];
    foldedSection(() => recordScrollsOn("target", first));

    followBoardAnchor(clickEvent(), "target", "sec");
    // The opening section re-renders during its animation and replaces the node — a fold
    // is a React subtree mounting, not a static append. A jump that captured the element
    // up front would scroll a node that is no longer in the document.
    document.getElementById("target")?.remove();
    const replacement = document.createElement("div");
    replacement.id = "target";
    document.getElementById("sec")?.append(replacement);
    recordScrollsOn("target", second);

    vi.advanceTimersByTime(200);
    expect(first).toEqual([]);
    expect(second).toEqual([{ behavior: "smooth", block: "start" }]);
  });

  it("scrolls on the next frame under prefers-reduced-motion", () => {
    reducedMotion(true);
    const scrolls: unknown[] = [];
    foldedSection(() => recordScrollsOn("target", scrolls));

    followBoardAnchor(clickEvent(), "target", "sec");
    // The track snaps (`motion-reduce:transition-none`), so the geometry is already final
    // and waiting a fifth of a second would be a stall with nothing behind it.
    vi.advanceTimersToNextFrame();
    expect(scrolls).toEqual([{ behavior: "smooth", block: "start" }]);
  });

  it("scrolls straight away when nothing needed unfolding", () => {
    reducedMotion(false);
    const scrolls: unknown[] = [];
    document.body.innerHTML = `<section data-kind="board-section" data-open="true"><div id="target"></div></section>`;
    recordScrollsOn("target", scrolls);

    followBoardAnchor(clickEvent(), "target", "target");
    expect(scrolls).toEqual([{ behavior: "smooth", block: "start" }]);
  });
});
