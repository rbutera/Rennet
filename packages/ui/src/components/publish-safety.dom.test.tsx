// @vitest-environment happy-dom
//
// The PUBLISH SAFETY GATE (issue #80). Mounted-DOM interaction tests that OBSERVE
// what the publish sheet emits — the red-provable replacement for the vacuous SSR
// presence check (`destination.test.tsx`'s old `data-hold-ms="800"` assertion).
//
// PR #76's adversarial review proved the exposure: mutations that made the sheet
// emit different bytes than the preview (MUT A) or sign on ANY pointer release
// (MUT C) passed all green SSR tests, because nothing observed the callback. These
// tests close that gap ahead of #21 wiring real publishing. Every assertion here
// mounts a live tree, drives a real DOM event, and observes `onSign` directly.
//
// The pointer path reads `Date.now()` for the hold duration, so a completed hold
// needs a controlled clock: `vi.useFakeTimers()` + `vi.setSystemTime()` bracket the
// mousedown/mouseup. No `mouseLeave` between them — that clears the hold.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToBatch, type DispositionBatch } from "../canvas/authoring";
import {
  destinationVariant,
  draftsFromWrites,
  type PublishLedger,
  stagedPayload,
} from "../canvas/destination";
import type { DispositionWrite } from "../canvas/logic";
import { fireEvent, mount } from "../test/dom";
import { PublishSheet } from "./publish-sheet";

const writes: DispositionWrite[] = [
  { path: "src/alpha.ts", type: "approve", body: "good" },
  { path: "src/beta.ts", type: "request-change", body: 'rename "x" to "y"' },
];

function stage(...ws: DispositionWrite[]): DispositionBatch {
  return addToBatch([], draftsFromWrites(ws));
}

const ledger: PublishLedger = {
  entries: [{ id: "sec-skipped", summary: "Security angle skipped — budget exhausted" }],
};

function signButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(".publish-sheet-sign");
  if (!button) throw new Error("the sign control did not mount");
  return button;
}

/**
 * Complete a pointer hold of exactly `heldMs` between mousedown and mouseup, using
 * the fake clock so the component's `Date.now()` elapsed reads `heldMs`. No
 * `mouseLeave` in between (that clears the hold before it can sign).
 */
function pointerHold(button: HTMLButtonElement, heldMs: number): void {
  const base = 1_000_000;
  vi.setSystemTime(base);
  fireEvent.mouseDown(button);
  vi.setSystemTime(base + heldMs);
  fireEvent.mouseUp(button);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("emit fidelity (MUT A): a completed sign emits exactly the previewed bytes", () => {
  it("a sufficient hold calls onSign once with a string byte-equal to stagedPayload(batch)", () => {
    const batch = stage(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        batch={batch}
        variant={destinationVariant("other-pr")}
        onSign={(payload) => signed.push(payload)}
      />,
    );

    pointerHold(signButton(container), 850);

    // Byte-equal to the preview source — never a transform. If `endHold` emitted
    // `payload + "\n"` or `payload.toUpperCase()`, this `.toBe` goes red.
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(stagedPayload(batch));
  });
});

describe("hold-gate wiring (MUT C): a hold below the budget never signs", () => {
  it("a too-short hold does NOT sign; a second sufficient hold does", () => {
    const batch = stage(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        batch={batch}
        variant={destinationVariant("other-pr")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);

    // Below the 800ms bar: nothing leaves. If `endHold` signed unconditionally
    // (ignoring resolveSign's null), this would be length 1 → red.
    pointerHold(button, 200);
    expect(signed).toHaveLength(0);

    // At/above the bar: it signs, byte-equal.
    pointerHold(button, 850);
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(stagedPayload(batch));
  });
});

describe("ledger gate: unacknowledged degradations block signing", () => {
  it("an unacknowledged ledger blocks a sufficient hold; acknowledging unblocks it", () => {
    const batch = stage(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        batch={batch}
        variant={destinationVariant("other-pr")}
        ledger={ledger}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);

    // Blocked regardless of hold: an unacknowledged degradation cannot publish.
    pointerHold(button, 850);
    expect(signed).toHaveLength(0);

    // Acknowledge, then the same hold signs — byte-equal.
    const ack = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ack) throw new Error("the acknowledge control did not render for a non-empty ledger");
    fireEvent.click(ack);

    pointerHold(button, 850);
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(stagedPayload(batch));
  });

  it("renders each entry's human-readable summary so the reviewer SEES what degraded", () => {
    const { container } = mount(
      <PublishSheet
        batch={stage(...writes)}
        variant={destinationVariant("other-pr")}
        ledger={ledger}
      />,
    );
    const entry = ledger.entries[0];
    if (!entry) throw new Error("the ledger fixture must carry at least one entry");
    // Structure alone (the id attribute) is not the safety property — the reviewer
    // must SEE the degradation before acknowledging it. Removing the visible
    // `{entry.summary}` from the render (leaving the id) reddens the text assertion.
    expect(container.querySelector(`[data-ledger-id="${entry.id}"]`)).not.toBeNull();
    expect(container.textContent).toContain(entry.summary);
  });
});

describe("keyboard sign (a11y): Enter/Space on the focused control signs deliberately", () => {
  it("Enter signs with byte-equal stagedPayload at the default non-zero hold", () => {
    const batch = stage(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        batch={batch}
        variant={destinationVariant("own-branch")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);
    button.focus();

    // At the default holdToSignMs=800 the OLD onKeyDown (resolveSign(0, 800)) would
    // return null and never sign — the a11y barrier. A deliberate keypress now signs.
    fireEvent.keyDown(button, { key: "Enter" });

    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(stagedPayload(batch));
  });

  it("Space also signs, byte-equal", () => {
    const batch = stage(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        batch={batch}
        variant={destinationVariant("own-branch")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);
    button.focus();
    fireEvent.keyDown(button, { key: " " });

    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(stagedPayload(batch));
  });

  it("a non-sign key does nothing", () => {
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        batch={stage(...writes)}
        variant={destinationVariant("own-branch")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);
    button.focus();
    fireEvent.keyDown(button, { key: "a" });
    expect(signed).toHaveLength(0);
  });

  it("keyboard ledger gate: Enter is blocked unacknowledged, then signs once acknowledged", () => {
    const batch = stage(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        batch={batch}
        variant={destinationVariant("own-branch")}
        ledger={ledger}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);
    button.focus();

    // Unacknowledged: Enter is blocked.
    fireEvent.keyDown(button, { key: "Enter" });
    expect(signed).toHaveLength(0);

    // Acknowledge, then Enter signs exactly once, byte-equal. Proves the gate
    // REOPENS — a mutation that permanently blocked keyboard signing whenever any
    // ledger exists would pass the block-only assertion but fail this one.
    const ack = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ack) throw new Error("the acknowledge control did not render for a non-empty ledger");
    fireEvent.click(ack);

    fireEvent.keyDown(button, { key: "Enter" });
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(stagedPayload(batch));
  });
});

describe("ledger swap fail-closed: a changed ledger re-blocks a prior acknowledgement", () => {
  it("acknowledging ledger A does NOT authorize signing a different ledger B", () => {
    const batch = stage(...writes);
    const signed: string[] = [];
    const ledgerA: PublishLedger = { entries: [{ id: "a-skipped", summary: "Angle A skipped" }] };
    const ledgerB: PublishLedger = { entries: [{ id: "b-skipped", summary: "Angle B skipped" }] };
    const { container, rerender } = mount(
      <PublishSheet
        batch={batch}
        variant={destinationVariant("other-pr")}
        ledger={ledgerA}
        onSign={(payload) => signed.push(payload)}
      />,
    );

    // Acknowledge A, then a sufficient hold signs.
    const ackA = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ackA) throw new Error("the acknowledge control did not render for ledger A");
    fireEvent.click(ackA);
    pointerHold(signButton(container), 850);
    expect(signed).toHaveLength(1);

    // The ledger swaps to a DIFFERENT degradation set while the sheet stays mounted
    // (a #22/council re-run). The prior acknowledgement must NOT carry over.
    rerender(
      <PublishSheet
        batch={batch}
        variant={destinationVariant("other-pr")}
        ledger={ledgerB}
        onSign={(payload) => signed.push(payload)}
      />,
    );

    // Re-blocked on BOTH sign paths — no new sign. Without the ledger-signature
    // reset, `acknowledged` carries over from A and the hold signs → red here.
    const button = signButton(container);
    pointerHold(button, 850);
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
    expect(signed).toHaveLength(1);

    // Acknowledging B reopens both paths, byte-equal.
    const ackB = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ackB) throw new Error("the acknowledge control did not render for ledger B");
    fireEvent.click(ackB);
    pointerHold(button, 850);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(signed).toHaveLength(3);
    expect(signed[1]).toBe(stagedPayload(batch));
    expect(signed[2]).toBe(stagedPayload(batch));
  });
});

describe("keyboard auto-repeat: a held sign key fires onSign only once", () => {
  it("a repeat keydown does not re-fire onSign", () => {
    const batch = stage(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        batch={batch}
        variant={destinationVariant("own-branch")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);
    button.focus();

    // First activation signs; the auto-repeat keydown (repeat:true) from a HELD key
    // must be ignored, or #21's real publish double-fires. Without the event.repeat
    // guard this is length 2 → red.
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: "Enter", repeat: true });

    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(stagedPayload(batch));
  });
});

describe("honesty affordance: the shell discloses that nothing is published", () => {
  it("carries a persistent, aria-legible notice that the shell publishes nothing", () => {
    const { container } = mount(
      <PublishSheet batch={stage(...writes)} variant={destinationVariant("own-branch")} />,
    );
    const notice = container.querySelector(".publish-sheet-shell-notice");
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("role")).toBe("note");
    expect(notice?.textContent).toContain("publishes nothing");
    expect(notice?.textContent).toContain("#21");
  });
});
