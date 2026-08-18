// @vitest-environment happy-dom
//
// Hold-to-sign progress feedback (critique P1-C). Before this, a hold gave NO progress
// feedback — the sole cue was a `is-arming` opacity that only ever applied in the
// zero-budget floor case. These prove the hold is now LEGIBLE: a fill appears during the
// press keyed to `holdToSignMs`, an early release announces "too soon" without signing,
// and a completed hold still signs (the reassurance never became a gate — Rule Zero).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { destinationVariant } from "../canvas/destination";
import type { DispositionWrite } from "../canvas/logic";
import { fireEvent, mount } from "../test/dom";
import { PublishSheet } from "./publish-sheet";

const items: DispositionWrite[] = [{ path: "src/a.ts", type: "comment", body: "note" }];
const payload = "OUTBOUND-BYTES";

function signButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(".publish-sheet-sign");
  if (!button) throw new Error("the sign control did not mount");
  return button;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("hold-to-sign progress feedback (critique P1-C)", () => {
  it("renders a hold-progress fill during the press, keyed to the hold budget", () => {
    const { container } = mount(
      <PublishSheet items={items} payload={payload} variant={destinationVariant("other-pr")} />,
    );
    const button = signButton(container);
    // No fill at rest.
    expect(container.querySelector('[data-testid="sign-hold-fill"]')).toBeNull();
    fireEvent.mouseDown(button);
    const fill = container.querySelector<HTMLElement>('[data-testid="sign-hold-fill"]');
    expect(fill).not.toBeNull();
    // The fill animates over EXACTLY the hold budget (default 800ms), off the prop.
    expect(fill?.style.animationDuration).toBe("800ms");
    expect(button.className).toContain("is-holding");
  });

  it("uses the passed holdToSignMs as the fill duration", () => {
    const { container } = mount(
      <PublishSheet
        items={items}
        payload={payload}
        variant={destinationVariant("other-pr")}
        holdToSignMs={1500}
      />,
    );
    fireEvent.mouseDown(signButton(container));
    expect(
      container.querySelector<HTMLElement>('[data-testid="sign-hold-fill"]')?.style
        .animationDuration,
    ).toBe("1500ms");
  });

  it("announces 'released too soon' and signs NOTHING on a below-budget release", () => {
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        items={items}
        payload={payload}
        variant={destinationVariant("other-pr")}
        onSign={(p) => signed.push(p)}
      />,
    );
    const button = signButton(container);
    const base = 1_000_000;
    vi.setSystemTime(base);
    fireEvent.mouseDown(button);
    vi.setSystemTime(base + 200); // well under the 800ms budget
    fireEvent.mouseUp(button);
    // Nothing signed…
    expect(signed).toHaveLength(0);
    // …and the reassurance is announced, not silent.
    const note = container.querySelector('[data-testid="sign-released-early"]');
    expect(note).not.toBeNull();
    expect(note?.getAttribute("role")).toBe("status");
    // The fill is gone once released.
    expect(container.querySelector('[data-testid="sign-hold-fill"]')).toBeNull();
  });

  it("clears the 'too soon' note when a fresh hold begins", () => {
    const { container } = mount(
      <PublishSheet items={items} payload={payload} variant={destinationVariant("other-pr")} />,
    );
    const button = signButton(container);
    const base = 1_000_000;
    vi.setSystemTime(base);
    fireEvent.mouseDown(button);
    vi.setSystemTime(base + 100);
    fireEvent.mouseUp(button);
    expect(container.querySelector('[data-testid="sign-released-early"]')).not.toBeNull();
    // A new attempt starts clean.
    fireEvent.mouseDown(button);
    expect(container.querySelector('[data-testid="sign-released-early"]')).toBeNull();
  });

  it("still signs on a completed hold — the feedback is not a gate", () => {
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        items={items}
        payload={payload}
        variant={destinationVariant("other-pr")}
        onSign={(p) => signed.push(p)}
      />,
    );
    const button = signButton(container);
    const base = 1_000_000;
    vi.setSystemTime(base);
    fireEvent.mouseDown(button);
    vi.setSystemTime(base + 850); // clears the 800ms budget
    fireEvent.mouseUp(button);
    expect(signed).toEqual([payload]);
    // A completed sign shows no "too soon" note.
    expect(container.querySelector('[data-testid="sign-released-early"]')).toBeNull();
  });
});
