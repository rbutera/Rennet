// @vitest-environment happy-dom
//
// Hold-to-sign progress feedback (critique P1-C). Before this, a hold gave NO progress
// feedback — the sole cue was a `is-arming` opacity that only ever applied in the
// zero-budget floor case. These prove the hold is now LEGIBLE: a fill appears during the
// press keyed to `holdToSignMs`, an early release announces "too soon" without signing,
// and a completed hold still signs (the reassurance never became a gate — Rule Zero).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { destinationVariant, type PublishLedger } from "../canvas/destination";
import type { DispositionWrite } from "../canvas/logic";
import { act, fireEvent, mount } from "../test/dom";
import { PublishSheet } from "./publish-sheet";

const items: DispositionWrite[] = [{ path: "src/a.ts", type: "comment", body: "note" }];
const payload = "OUTBOUND-BYTES";
const unackedLedger: PublishLedger = {
  entries: [{ id: "sec-skipped", summary: "Security angle skipped — budget exhausted" }],
};

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
    // The fill is rendered persistently; at rest the button is not holding, so the
    // `.is-holding` class (which arms the CSS animation) is absent.
    const fill = container.querySelector<HTMLElement>('[data-testid="sign-hold-fill"]');
    expect(fill).not.toBeNull();
    expect(button.className).not.toContain("is-holding");
    fireEvent.mouseDown(button);
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
    // The animation is disarmed once released — the persistent fill loses `.is-holding`.
    expect(button.className).not.toContain("is-holding");
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

  it("gates eligibility on the SAME budget the fill animates over — visual and eligibility coincide", () => {
    // The visual completion (fill runs for `animationDuration`) and sign eligibility
    // (`canSign` at `holdToSignMs`) are one number: a release one tick UNDER the budget
    // signs nothing, a release AT the budget signs, and the fill's animation runs for
    // exactly that many ms. So the bar cannot visually complete before the hold is
    // eligible, nor sign while it still looks unfilled.
    const signed: string[] = [];
    const budget = 1000;
    const { container } = mount(
      <PublishSheet
        items={items}
        payload={payload}
        variant={destinationVariant("other-pr")}
        holdToSignMs={budget}
        onSign={(p) => signed.push(p)}
      />,
    );
    const button = signButton(container);
    const fill = container.querySelector<HTMLElement>('[data-testid="sign-hold-fill"]');
    // The fill runs for exactly the eligibility budget.
    expect(fill?.style.animationDuration).toBe(`${budget}ms`);

    // One tick under the budget: not yet eligible, nothing signs.
    const base = 2_000_000;
    vi.setSystemTime(base);
    fireEvent.mouseDown(button);
    vi.setSystemTime(base + budget - 1);
    fireEvent.mouseUp(button);
    expect(signed).toHaveLength(0);

    // Exactly at the budget (when the fill reaches 100%): eligible, it signs.
    vi.setSystemTime(base + 10_000);
    fireEvent.mouseDown(button);
    vi.setSystemTime(base + 10_000 + budget);
    fireEvent.mouseUp(button);
    expect(signed).toEqual([payload]);
  });

  it("stamps the eligibility epoch at COMMIT time, not pointer-down time", () => {
    // Proves the epoch lives in the layout effect (committed render), not the pointer-down
    // handler. Reverting to handler-stamping captures `press` and this hold would sign;
    // the layout-effect stamps `commit`, so a release one tick under budget by the
    // committed clock is ineligible. Raw dispatch inside our own act() defers the layout
    // effect's flush to act-exit, so the clock can advance between the handler and the
    // commit — which frozen-time tests cannot show.
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
    const press = 3_000_000;
    const commit = press + 50; // 50ms elapse between the handler running and the commit
    vi.setSystemTime(press);
    act(() => {
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      vi.setSystemTime(commit); // advance BEFORE the layout effect flushes at act-exit
    });
    // 799ms after the COMMIT: under the 800ms budget by the effect's clock (nothing signs),
    // but 849ms after pointer-down — handler-stamping would sign here.
    vi.setSystemTime(commit + 799);
    fireEvent.mouseUp(button);
    expect(signed).toHaveLength(0);
  });

  it("re-stamps the epoch after a mid-hold disable — a stale hold cannot sign sub-budget", () => {
    // Regression (fix loop 1): a ledger arriving mid-hold disables the button, which eats
    // the mouseup so `endHold` never runs and `holding` stays true. Before the clear-on-
    // disable effect, the next press's `setHolding(true)` was a no-op that never re-fired
    // the epoch stamp, so an instant release signed against the stale press timestamp.
    const signed: string[] = [];
    const { container, rerender } = mount(
      <PublishSheet
        items={items}
        payload={payload}
        variant={destinationVariant("other-pr")}
        holdToSignMs={800}
        onSign={(p) => signed.push(p)}
      />,
    );
    const button = signButton(container);

    // Begin a hold while the button is enabled (no ledger).
    vi.setSystemTime(5_000_000);
    fireEvent.mouseDown(button);

    // A degradation ledger arrives mid-hold → the button disables (P2c: disabled true).
    rerender(
      <PublishSheet
        items={items}
        payload={payload}
        variant={destinationVariant("other-pr")}
        holdToSignMs={800}
        onSign={(p) => signed.push(p)}
        ledger={unackedLedger}
      />,
    );
    expect(button.disabled).toBe(true);
    // A long wall-clock passes while the reviewer reads and acknowledges. Release is eaten
    // by the disabled button; nothing signs.
    vi.setSystemTime(5_050_000);
    fireEvent.mouseUp(button);
    expect(signed).toHaveLength(0);

    // Acknowledge → the button re-enables (P2c: disabled false).
    const ack = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ack) throw new Error("the acknowledge control did not render for a non-empty ledger");
    fireEvent.click(ack);
    expect(button.disabled).toBe(false);

    // A FRESH sub-budget hold must measure from the fresh press — signing nothing.
    fireEvent.mouseDown(button);
    vi.setSystemTime(5_050_000 + 200); // 200ms < 800ms budget
    fireEvent.mouseUp(button);
    expect(signed).toHaveLength(0);
  });
});
