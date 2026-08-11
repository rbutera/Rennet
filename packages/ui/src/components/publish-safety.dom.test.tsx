// @vitest-environment happy-dom
//
// The PUBLISH SAFETY GATE (issue #80), re-proven against the R40-narrowed paper
// (issue #101). Mounted-DOM interaction tests that OBSERVE what the paper emits.
//
// R40 narrowed the paper: it no longer re-derives its payload from a batch it is
// given; it is handed the EXACT outbound bytes (`payload`) and the ordered item
// list (`items`). The #80 gate MECHANICS are unchanged — resolveSign, the ledger
// gate, the hold budget, the keyboard path, the auto-repeat guard, the ledger-swap
// fail-closed — so every safety property below is the same property, now proven
// over the collation payload the sheet actually signs. Each test still mounts a
// live tree, drives a real DOM event, and observes `onSign` directly.
//
// The pointer path reads `Date.now()` for the hold duration, so a completed hold
// needs a controlled clock: `vi.useFakeTimers()` + `vi.setSystemTime()` bracket the
// mousedown/mouseup. No `mouseLeave` between them — that clears the hold.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToBatch, type DispositionBatch } from "../canvas/authoring";
import {
  type CollationDraft,
  collationItems,
  collationPayload,
  draftFromBatch,
} from "../canvas/collation";
import { destinationVariant, draftsFromWrites, type PublishLedger } from "../canvas/destination";
import type { DispositionWrite } from "../canvas/logic";
import { fireEvent, mount } from "../test/dom";
import { PublishSheet } from "./publish-sheet";

const writes: DispositionWrite[] = [
  { path: "src/alpha.ts", type: "approve", body: "good" },
  { path: "src/beta.ts", type: "request-change", body: 'rename "x" to "y"' },
];

function stagedDraft(...ws: DispositionWrite[]): CollationDraft {
  const batch: DispositionBatch = addToBatch([], draftsFromWrites(ws));
  return draftFromBatch(batch);
}

/** The paper's two inputs: the ordered list and the exact bytes it signs. */
function paper(draft: CollationDraft): { items: DispositionWrite[]; payload: string } {
  return { items: collationItems(draft), payload: collationPayload(draft) };
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

/**
 * Complete a KEYBOARD hold of `heldMs` (issue #21): press the sign key, advance the
 * fake clock, release. Keyboard is now a real hold too — a single keypress no longer
 * signs, because the sign is a real GitHub egress — so a completed keyboard sign is
 * keydown → (elapsed) → keyup, through the same `resolveSign` budget gate as pointer.
 */
function keyboardHold(button: HTMLButtonElement, heldMs: number, key = "Enter"): void {
  const base = 1_000_000;
  vi.setSystemTime(base);
  button.focus();
  fireEvent.keyDown(button, { key });
  vi.setSystemTime(base + heldMs);
  fireEvent.keyUp(button, { key });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("emit fidelity (MUT A): a completed sign emits exactly the previewed bytes", () => {
  it("a sufficient hold calls onSign once with the exact payload it was handed", () => {
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        {...paper(draft)}
        variant={destinationVariant("other-pr")}
        onSign={(payload) => signed.push(payload)}
      />,
    );

    pointerHold(signButton(container), 850);

    // Byte-equal to the payload prop (== the preview source) — never a transform.
    // If `endHold` emitted `payload + "\n"` or `payload.toUpperCase()`, this reddens.
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(collationPayload(draft));
  });
});

describe("emit fidelity (MUT A′): the sheet signs the HANDED payload, never a re-derivation from items", () => {
  // The R40 migration hands the paper TWO inputs: the ordered `items` (for the
  // legible list) and the exact `payload` (the bytes it signs). Every OTHER fidelity
  // test supplies mutually-derived inputs (payload === JSON.stringify(items) via
  // `paper()`), so none can distinguish "signs the handed payload" from "re-derives
  // JSON.stringify(items)". This uses a SENTINEL payload NOT derivable from the
  // items, so a re-derivation from `items` reddens on preview, pointer, and keyboard.
  const sentinel = "SENTINEL-PAYLOAD::not-json-stringify-of-items::7f3a";
  const unrelatedItems: DispositionWrite[] = [
    { path: "src/unrelated.ts", type: "comment", body: "these items are NOT the payload" },
  ];

  it("previews and pointer-signs the sentinel payload verbatim, not JSON.stringify(items)", () => {
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        items={unrelatedItems}
        payload={sentinel}
        variant={destinationVariant("other-pr")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    // Preview renders the handed payload verbatim (not the item list).
    expect(container.querySelector('[data-testid="publish-preview"]')?.textContent).toBe(sentinel);
    // A completed hold emits the handed payload, byte-equal. If `endHold` signed
    // `JSON.stringify(items)` (or any re-derivation from items), this reddens.
    pointerHold(signButton(container), 850);
    expect(signed).toEqual([sentinel]);
  });

  it("keyboard-signs the sentinel payload verbatim", () => {
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        items={unrelatedItems}
        payload={sentinel}
        variant={destinationVariant("own-branch")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);
    keyboardHold(button, 850);
    expect(signed).toEqual([sentinel]);
  });
});

describe("paper freeze (MUT #74 HIGH-2): a payload swap mid-hold voids the hold", () => {
  const items: DispositionWrite[] = [{ path: "src/x.ts", type: "comment", body: "note" }];
  const A = "PAYLOAD-A::draft-before-the-model-result";
  const B = "PAYLOAD-B::draft-after-the-model-result";

  it("a late result recomposing the payload DURING a hold signs NOTHING", () => {
    const signed: string[] = [];
    const onSign = (payload: string) => signed.push(payload);
    const { container, rerender } = mount(
      <PublishSheet
        items={items}
        payload={A}
        variant={destinationVariant("other-pr")}
        onSign={onSign}
      />,
    );
    const base = 1_000_000;
    vi.setSystemTime(base);
    fireEvent.mouseDown(signButton(container)); // begin the hold over payload A
    // The "Draft with AI" turn resolves, recomposing the target → the paper re-renders
    // with NEW bytes B while the hold is still in progress (the reproduced scenario).
    rerender(
      <PublishSheet
        items={items}
        payload={B}
        variant={destinationVariant("other-pr")}
        onSign={onSign}
      />,
    );
    vi.setSystemTime(base + 850); // a duration that WOULD sign an unbroken hold
    fireEvent.mouseUp(signButton(container));
    // Signing B off a hold begun over A is the HIGH-2 hole. The hold is bound to the
    // bytes it started over, so nothing is signed. RED-proof: remove the payload
    // binding in publish-sheet and this reddens with signed === [B].
    expect(signed).toEqual([]);
  });

  it("a fresh hold AFTER the swap signs the new bytes (the void is not a permanent block)", () => {
    const signed: string[] = [];
    const onSign = (payload: string) => signed.push(payload);
    const { container, rerender } = mount(
      <PublishSheet
        items={items}
        payload={A}
        variant={destinationVariant("other-pr")}
        onSign={onSign}
      />,
    );
    rerender(
      <PublishSheet
        items={items}
        payload={B}
        variant={destinationVariant("other-pr")}
        onSign={onSign}
      />,
    );
    // A deliberate fresh hold over the CURRENT bytes B signs B — the fix voids a
    // stale hold, it does not disable signing.
    pointerHold(signButton(container), 850);
    expect(signed).toEqual([B]);
  });
});

describe("hold-gate wiring (MUT C): a hold below the budget never signs", () => {
  it("a too-short hold does NOT sign; a second sufficient hold does", () => {
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        {...paper(draft)}
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
    expect(signed[0]).toBe(collationPayload(draft));
  });
});

describe("ledger gate: unacknowledged degradations block signing", () => {
  it("an unacknowledged ledger blocks a sufficient hold; acknowledging unblocks it", () => {
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        {...paper(draft)}
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
    expect(signed[0]).toBe(collationPayload(draft));
  });

  it("renders each entry's human-readable summary so the reviewer SEES what degraded", () => {
    const { container } = mount(
      <PublishSheet
        {...paper(stagedDraft(...writes))}
        variant={destinationVariant("other-pr")}
        ledger={ledger}
      />,
    );
    const entry = ledger.entries[0];
    if (!entry) throw new Error("the ledger fixture must carry at least one entry");
    expect(container.querySelector(`[data-ledger-id="${entry.id}"]`)).not.toBeNull();
    expect(container.textContent).toContain(entry.summary);
  });
});

describe("keyboard sign (a11y): a HELD Enter/Space signs deliberately (issue #21)", () => {
  it("a keyboard hold that clears the budget signs, byte-equal", () => {
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        {...paper(draft)}
        variant={destinationVariant("own-branch")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    keyboardHold(signButton(container), 850);

    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(collationPayload(draft));
  });

  it("a keyboard hold BELOW the budget does not sign (a single keypress no longer posts)", () => {
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        {...paper(draft)}
        variant={destinationVariant("own-branch")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    // A quick press-and-release (200ms < 800ms) does NOT sign — the exact gap issue #21
    // closed, where one Enter fired a real GitHub post.
    keyboardHold(signButton(container), 200);
    expect(signed).toHaveLength(0);
  });

  it("Space also signs on a completed hold, byte-equal", () => {
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        {...paper(draft)}
        variant={destinationVariant("own-branch")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    keyboardHold(signButton(container), 850, " ");

    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(collationPayload(draft));
  });

  it("a non-sign key does nothing", () => {
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        {...paper(stagedDraft(...writes))}
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
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        {...paper(draft)}
        variant={destinationVariant("own-branch")}
        ledger={ledger}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);

    // A completed keyboard hold is still blocked while the ledger is unacknowledged.
    keyboardHold(button, 850);
    expect(signed).toHaveLength(0);

    const ack = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ack) throw new Error("the acknowledge control did not render for a non-empty ledger");
    fireEvent.click(ack);

    keyboardHold(button, 850);
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(collationPayload(draft));
  });
});

describe("ledger swap fail-closed: a changed ledger re-blocks a prior acknowledgement", () => {
  it("acknowledging ledger A does NOT authorize signing a different ledger B", () => {
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const ledgerA: PublishLedger = { entries: [{ id: "a-skipped", summary: "Angle A skipped" }] };
    const ledgerB: PublishLedger = { entries: [{ id: "b-skipped", summary: "Angle B skipped" }] };
    const { container, rerender } = mount(
      <PublishSheet
        {...paper(draft)}
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
        {...paper(draft)}
        variant={destinationVariant("other-pr")}
        ledger={ledgerB}
        onSign={(payload) => signed.push(payload)}
      />,
    );

    // Re-blocked on BOTH sign paths — no new sign. Without the ledger-signature
    // reset, `acknowledged` carries over from A and the hold signs → red here.
    const button = signButton(container);
    pointerHold(button, 850);
    keyboardHold(button, 850);
    expect(signed).toHaveLength(1);

    // Acknowledging B reopens both paths, byte-equal.
    const ackB = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ackB) throw new Error("the acknowledge control did not render for ledger B");
    fireEvent.click(ackB);
    pointerHold(button, 850);
    keyboardHold(button, 850);
    expect(signed).toHaveLength(3);
    expect(signed[1]).toBe(collationPayload(draft));
    expect(signed[2]).toBe(collationPayload(draft));
  });

  it("re-blocks when the SUMMARY changes under a STABLE id (a council re-run's new reason)", () => {
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const sameId = "sec-skipped";
    const before: PublishLedger = {
      entries: [{ id: sameId, summary: "Security angle skipped — budget exhausted" }],
    };
    const after: PublishLedger = {
      entries: [{ id: sameId, summary: "Security angle skipped — harness error" }],
    };
    const { container, rerender } = mount(
      <PublishSheet
        {...paper(draft)}
        variant={destinationVariant("other-pr")}
        ledger={before}
        onSign={(payload) => signed.push(payload)}
      />,
    );

    // Acknowledge the first reason and sign once.
    const ack = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ack) throw new Error("the acknowledge control did not render for the first ledger");
    fireEvent.click(ack);
    pointerHold(signButton(container), 850);
    expect(signed).toHaveLength(1);

    // The degradation TEXT changes under the SAME id — a genuinely different
    // degradation the reviewer has NOT acknowledged. An id-only signature would
    // carry the stale ack over and sign the new reason; the id+summary signature
    // re-blocks. Without summary in the signature, this reddens.
    rerender(
      <PublishSheet
        {...paper(draft)}
        variant={destinationVariant("other-pr")}
        ledger={after}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    pointerHold(signButton(container), 850);
    expect(signed).toHaveLength(1); // still blocked — no new sign

    // Acknowledging the NEW reason reopens signing.
    const ack2 = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ack2) throw new Error("the acknowledge control did not render for the changed ledger");
    fireEvent.click(ack2);
    pointerHold(signButton(container), 850);
    expect(signed).toHaveLength(2);
  });
});

describe("keyboard auto-repeat: a held sign key measures the hold from the FIRST press", () => {
  // Both sign keys, since the repeat guard is key-agnostic (`if (event.repeat)`): if it
  // were ever narrowed to Enter only, a HELD Space's auto-repeat would reset the hold
  // clock and only the Space row reddens.
  it.each([["Enter"], [" "]])("a repeat %s keydown does not reset the hold clock", (key) => {
    const draft = stagedDraft(...writes);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        {...paper(draft)}
        variant={destinationVariant("own-branch")}
        onSign={(payload) => signed.push(payload)}
      />,
    );
    const button = signButton(container);
    button.focus();

    // A HELD key emits: one real keydown, then a stream of auto-repeat keydowns, then
    // one keyup on release. The repeats must be IGNORED so the hold is measured from the
    // FIRST press. Here the first press is at t0, a repeat lands at t0+500, and release
    // at t0+850. If the repeat reset the clock (guard removed), the measured hold would
    // be 350ms < 800ms and NOTHING signs → red. With the guard it is 850ms → one sign.
    const base = 1_000_000;
    vi.setSystemTime(base);
    fireEvent.keyDown(button, { key });
    vi.setSystemTime(base + 500);
    fireEvent.keyDown(button, { key, repeat: true });
    vi.setSystemTime(base + 850);
    fireEvent.keyUp(button, { key });

    expect(signed).toHaveLength(1);
    expect(signed[0]).toBe(collationPayload(draft));
  });
});

describe("honesty affordance: the shell discloses that nothing is published", () => {
  it("carries a persistent, aria-legible notice that the shell publishes nothing", () => {
    const { container } = mount(
      <PublishSheet
        {...paper(stagedDraft(...writes))}
        variant={destinationVariant("own-branch")}
      />,
    );
    const notice = container.querySelector(".publish-sheet-shell-notice");
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("role")).toBe("note");
    // own-branch (issue #109, own-branch half): the shell discloses that creating the
    // PR is the separate, gated #21 act and that NOTHING is pushed from here — the
    // honest own-branch disclosure, not the review path's "posts nothing".
    expect(notice?.textContent).toContain("nothing is pushed");
    expect(notice?.textContent).toContain("#21");
  });
});
