// @vitest-environment happy-dom
//
// The coach mark's anchor tracking, measured as a CADENCE (perf audit 2026-08-31, §1 H3).
// The spotlight used to re-measure its anchor on every animation frame — a forced style +
// layout recalc at display rate (120Hz on ProMotion) for as long as any mark was elected.
// It now polls at 250ms and skips a hidden document entirely. These tests drive the clock
// and read the rendered cutout, so they fail if the cadence regresses in either direction:
// per-frame tracking makes the "not yet" assertion red, and a dead timer makes the "by now"
// assertion red.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../data";
import { act, cleanup, mount } from "../test/dom";
import { SettingsStore } from "../test/fixtures/settings";
import { MemoryBridge } from "../test/memory-bridge";
import { Coachmark } from "./coachmark";
import { CoachDataProvider } from "./provider";
import { useCoachAnchor } from "./registry";

function Harness() {
  const startRef = useCoachAnchor("start-review");
  return (
    <div>
      <button type="button" ref={startRef} data-testid="start-anchor">
        start a review
      </button>
      <Coachmark />
    </div>
  );
}

/** Advance the fake clock and let React flush every update it schedules. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The portalled spotlight cutout — the only aria-hidden div carrying the scrim shadow. */
function spotlight(): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')].find(
    (el) => el.style.boxShadow.includes("9999px"),
  );
  if (!found) throw new Error("no spotlight cutout rendered — the mark never elected");
  return found;
}

/** Pin the anchor's measured box, as a scroll or a sidebar transition would move it. */
function moveAnchor(el: Element, top: number) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 100,
    bottom: top + 20,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect);
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function mountMark() {
  const result = mount(
    <BridgeProvider bridge={new MemoryBridge(new SettingsStore().handlers())}>
      <CoachDataProvider>
        <Harness />
      </CoachDataProvider>
    </BridgeProvider>,
  );
  // Let the settings read resolve and the first mark elect against its live anchor.
  await tick(0);
  await tick(0);
  return result;
}

describe("coach anchor tracking cadence (perf audit §1 H3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setHidden(false);
  });

  it("re-measures the anchor on a 250ms poll, not once per animation frame", async () => {
    const { getByTestId } = await mountMark();
    const anchor = getByTestId("start-anchor");
    const before = spotlight().style.top;

    moveAnchor(anchor, 300);
    // A frame (and several) have passed. Per-frame tracking would already have moved the
    // cutout; the 250ms poll has not fired yet, so the cutout is still where it was.
    await tick(100);
    expect(spotlight().style.top).toBe(before);

    // Past 250ms the poll fires and the cutout catches up with its anchor.
    await tick(200);
    expect(spotlight().style.top).toBe("294px");
  });

  it("measures nothing while the document is hidden, and catches up on return", async () => {
    const { getByTestId } = await mountMark();
    const anchor = getByTestId("start-anchor");
    const before = spotlight().style.top;

    setHidden(true);
    moveAnchor(anchor, 500);
    // Four seconds of hidden window: sixteen poll ticks, none of which touched layout.
    await tick(4_000);
    expect(spotlight().style.top).toBe(before);
    expect(anchor.getBoundingClientRect).not.toHaveBeenCalled();

    // Returning to the window measures on the spot rather than waiting out a throttled tick.
    setHidden(false);
    await tick(0);
    expect(spotlight().style.top).toBe("494px");
  });
});
