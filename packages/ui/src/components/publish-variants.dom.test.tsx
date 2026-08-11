// @vitest-environment happy-dom
//
// The #22 PUBLISH VARIANTS — mounted-DOM tests over the two context-dependent
// outbound artifacts a review produces, both DERIVED from one collation draft:
//  • own-branch → a PR submission preview (title / base←head / draft / body).
//  • other-pr   → a line-anchored review to post (every disposition as a comment).
//
// These extend, and never weaken, the #80 gates (see publish-safety.dom.test.tsx):
// signing stays impossible without an acknowledged ledger, and the previewed bytes
// equal the published bytes — now re-proven over BOTH variants' distinct payloads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollationDraft } from "../canvas/collation";
import type { PublishLedger } from "../canvas/destination";
import { destinationVariant } from "../canvas/destination";
import {
  type LineAnchors,
  type PublishContext,
  publishTarget,
  publishTargetPayload,
} from "../canvas/publish";
import { fireEvent, mount } from "../test/dom";
import { PublishSheet } from "./publish-sheet";

// ONE review state — the single source both variants render from.
const draft: CollationDraft = [
  { id: "src/beta.ts", path: "src/beta.ts", type: "request-change", raw: 'rename "x" to "y"' },
  { id: "src/alpha.ts", path: "src/alpha.ts", type: "approve", raw: "looks right" },
];

const anchors: LineAnchors = {
  "src/beta.ts": { line: 42, side: "RIGHT" },
};

const context: PublishContext = {
  submission: { base: "main", head: "feat/publish-sheet", draftDefault: true },
  anchors,
};

function signButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(".publish-sheet-sign");
  if (!button) throw new Error("the sign control did not mount");
  return button;
}

function pointerHold(button: HTMLButtonElement, heldMs: number): void {
  const base = 1_000_000;
  vi.setSystemTime(base);
  fireEvent.mouseDown(button);
  vi.setSystemTime(base + heldMs);
  fireEvent.mouseUp(button);
}

/** A completed KEYBOARD hold (issue #21): a single keypress no longer signs. */
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

describe("both variants render from the same review state", () => {
  it("own-branch renders the PR submission (title, base←head, draft, composed body)", () => {
    const target = publishTarget("own-branch", draft, context);
    const { container } = mount(
      <PublishSheet
        target={target}
        payload={publishTargetPayload(target)}
        variant={destinationVariant("own-branch")}
      />,
    );
    // The submission card is present; the review-comment list is NOT (this is the PR variant).
    expect(container.querySelector('[data-testid="pr-submission"]')).not.toBeNull();
    expect(container.querySelector(".publish-sheet-comments")).toBeNull();
    // Title derived from head, branches shown, draft state shown, body composed.
    expect(container.querySelector(".publish-sheet-pr-title")?.textContent).toBe("Publish sheet");
    expect(container.querySelector('[data-testid="pr-branches"]')?.textContent).toContain("main");
    expect(container.querySelector('[data-testid="pr-branches"]')?.textContent).toContain(
      "feat/publish-sheet",
    );
    expect(container.querySelector(".publish-sheet-pr-state")?.textContent).toBe("Draft");
    expect(container.querySelector('[data-testid="pr-body"]')?.textContent).toContain(
      "Requested changes",
    );
  });

  it("own-branch previews the DRAFTED title + body (M26 override) — the draft reaches the paper", () => {
    // The whole #74 chain end to end: a drafted-then-edited title+body flows through
    // the submission context, and the paper — the publish preview — shows exactly the
    // human's account, not the deterministic disposition grouping. This is the DoD's
    // "a working PR title+body draft reaching the publish preview".
    const drafted =
      "## What\nBounds the rate limiter's fail-open path with a process-local bucket (decision 2).";
    const target = publishTarget("own-branch", draft, {
      submission: { ...context.submission, title: "Bound the fail-open path", body: drafted },
    });
    const { container } = mount(
      <PublishSheet
        target={target}
        payload={publishTargetPayload(target)}
        variant={destinationVariant("own-branch")}
      />,
    );
    expect(container.querySelector(".publish-sheet-pr-title")?.textContent).toBe(
      "Bound the fail-open path",
    );
    const body = container.querySelector('[data-testid="pr-body"]')?.textContent ?? "";
    expect(body).toContain("process-local bucket (decision 2)");
    // The deterministic grouping did NOT leak in alongside the drafted account.
    expect(body).not.toContain("Requested changes");
    // And the SIGNED bytes carry the drafted body — what you see is what leaves (R33).
    expect(container.querySelector('[data-testid="publish-preview"]')?.textContent).toContain(
      "process-local bucket (decision 2)",
    );
  });

  it("other-pr renders the line-anchored review comments (not a PR submission)", () => {
    const target = publishTarget("other-pr", draft, context);
    const { container } = mount(
      <PublishSheet
        target={target}
        payload={publishTargetPayload(target)}
        variant={destinationVariant("other-pr")}
      />,
    );
    expect(container.querySelector(".publish-sheet-comments")).not.toBeNull();
    expect(container.querySelector('[data-testid="pr-submission"]')).toBeNull();
    // The anchored disposition shows its line; the unanchored one shows file-level.
    const anchored = container.querySelector('[data-path="src/beta.ts"]');
    expect(anchored?.getAttribute("data-line")).toBe("42");
    expect(anchored?.textContent).toContain("src/beta.ts:42");
    const unanchored = container.querySelector('[data-path="src/alpha.ts"]');
    expect(unanchored?.getAttribute("data-line")).toBe("file");
    expect(unanchored?.textContent).toContain("(file)");
  });

  it("both variants come from the SAME draft — the two are framings of one review state", () => {
    // Rendering own-branch then other-pr from the identical `draft` proves neither
    // owns the data. Distinct payloads confirm distinct outbound artifacts.
    const own = publishTarget("own-branch", draft, context);
    const other = publishTarget("other-pr", draft, context);
    expect(publishTargetPayload(own)).not.toBe(publishTargetPayload(other));
  });
});

describe("refined-comment preview: raw fallback until #19", () => {
  it("marks an unrefined comment raw, and drops the marker once a refined form lands", () => {
    const refinedDraft: CollationDraft = [
      { id: "a", path: "a", type: "comment", raw: "raw one" },
      { id: "b", path: "b", type: "comment", raw: "raw two", refined: "cleaned two" },
    ];
    const target = publishTarget("other-pr", refinedDraft, { submission: context.submission });
    const { container } = mount(
      <PublishSheet
        target={target}
        payload={publishTargetPayload(target)}
        variant={destinationVariant("other-pr")}
      />,
    );
    // One raw marker (item a); item b's refined body renders with NO raw marker.
    const rawMarkers = container.querySelectorAll('[data-testid="comment-raw"]');
    expect(rawMarkers).toHaveLength(1);
    // The refined body is what's previewed for b (effective body prefers refined).
    expect(container.querySelector('[data-path="b"]')?.textContent).toContain("cleaned two");
  });
});

describe("emit fidelity over BOTH variants: previewed bytes == published bytes (R33)", () => {
  it.each([["own-branch"], ["other-pr"]] as const)(
    "%s: a completed hold emits exactly the previewed payload",
    (mode) => {
      const target = publishTarget(mode, draft, context);
      const payload = publishTargetPayload(target);
      const signed: string[] = [];
      const { container } = mount(
        <PublishSheet
          target={target}
          payload={payload}
          variant={destinationVariant(mode)}
          onSign={(bytes) => signed.push(bytes)}
        />,
      );
      // The preview <pre> shows exactly the payload; a sign emits exactly the payload.
      expect(container.querySelector('[data-testid="publish-preview"]')?.textContent).toBe(payload);
      pointerHold(signButton(container), 850);
      expect(signed).toEqual([payload]);
    },
  );
});

describe("the ledger gate holds over BOTH variants (issue #80, re-proven)", () => {
  const ledger: PublishLedger = {
    entries: [
      {
        id: "sec-skipped",
        summary: "Security angle skipped — budget exhausted",
        kind: "skipped-angle",
      },
    ],
  };

  it.each([["own-branch"], ["other-pr"]] as const)(
    "%s: an unacknowledged ledger blocks signing; acknowledging unblocks it",
    (mode) => {
      const target = publishTarget(mode, draft, context);
      const payload = publishTargetPayload(target);
      const signed: string[] = [];
      const { container } = mount(
        <PublishSheet
          target={target}
          payload={payload}
          variant={destinationVariant(mode)}
          ledger={ledger}
          onSign={(bytes) => signed.push(bytes)}
        />,
      );
      const button = signButton(container);
      // The ledger is visible AND blocks: a sufficient hold does not sign.
      expect(container.querySelector("[data-ledger-id='sec-skipped']")).not.toBeNull();
      pointerHold(button, 850);
      expect(signed).toHaveLength(0);
      // Acknowledge, then the same hold signs the byte-equal payload.
      const ack = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
      if (!ack) throw new Error("the acknowledge control did not render");
      fireEvent.click(ack);
      pointerHold(button, 850);
      expect(signed).toEqual([payload]);
    },
  );
});

describe("the #22 ledger CONTENT: buckets + honest counts", () => {
  const richLedger: PublishLedger = {
    counts: { total: 20, read: 14, attested: 9 },
    entries: [
      { id: "sec", summary: "Security angle skipped", kind: "skipped-angle" },
      { id: "orph", summary: "A disposition was dropped", kind: "orphaned", detail: "src/old.ts" },
      { id: "flat", summary: "Rich structure flattened on publish", kind: "flattened" },
    ],
  };

  it("groups entries into labelled buckets and states read-vs-attested honestly", () => {
    const target = publishTarget("other-pr", draft, context);
    const { container } = mount(
      <PublishSheet
        target={target}
        payload={publishTargetPayload(target)}
        variant={destinationVariant("other-pr")}
        ledger={richLedger}
      />,
    );
    // Buckets by kind, each present and labelled.
    expect(container.querySelector('[data-bucket="skipped-angle"]')).not.toBeNull();
    expect(container.querySelector('[data-bucket="orphaned"]')).not.toBeNull();
    expect(container.querySelector('[data-bucket="flattened"]')).not.toBeNull();
    // The orphaned entry's detail (the dropped path) is shown.
    expect(container.querySelector('[data-bucket="orphaned"]')?.textContent).toContain(
      "src/old.ts",
    );
    // The "published, but flattened" third-ink-state label is present.
    expect(container.textContent).toContain("Published, but flattened");
    // Read-vs-attested counts, stated honestly (9 of 20 attested, 14 read).
    const counts = container.querySelector('[data-testid="ledger-counts"]');
    expect(counts?.textContent).toContain("9 of 20 attested");
    expect(counts?.textContent).toContain("14 read");
  });
});

describe("ledger-swap fail-closed extends to the #22 content (counts / detail / kind)", () => {
  // #80 proves the ack resets when a degradation's id or summary changes. #22 added
  // counts, detail, and kind as content the reviewer inspects BEFORE acknowledging,
  // so a council re-run that changes any of them under a STABLE id+summary is a
  // genuinely different degradation the reviewer has NOT acknowledged. If the ack
  // signature omits these, the stale ack carries over and signs an unacknowledged
  // set — a fail-OPEN on the exact content #22 introduced.
  const swapDraft: CollationDraft = [
    { id: "src/beta.ts", path: "src/beta.ts", type: "request-change", raw: "x" },
  ];
  const ctx: PublishContext = {
    submission: { base: "main", head: "feat/x", draftDefault: true },
  };

  const cases: [string, PublishLedger, PublishLedger][] = [
    [
      "the attested count drops",
      { entries: [{ id: "x", summary: "s" }], counts: { total: 20, read: 14, attested: 9 } },
      { entries: [{ id: "x", summary: "s" }], counts: { total: 20, read: 14, attested: 3 } },
    ],
    [
      "the orphaned detail path changes",
      { entries: [{ id: "x", summary: "s", kind: "orphaned", detail: "src/old.ts" }] },
      { entries: [{ id: "x", summary: "s", kind: "orphaned", detail: "src/other.ts" }] },
    ],
    [
      "the degradation kind changes",
      { entries: [{ id: "x", summary: "s", kind: "skipped-angle" }] },
      { entries: [{ id: "x", summary: "s", kind: "flattened" }] },
    ],
  ];

  it.each(cases)("re-blocks when %s under a stable id+summary", (_label, before, after) => {
    const target = publishTarget("other-pr", swapDraft, ctx);
    const payload = publishTargetPayload(target);
    const signed: string[] = [];
    const { container, rerender } = mount(
      <PublishSheet
        target={target}
        payload={payload}
        variant={destinationVariant("other-pr")}
        ledger={before}
        onSign={(bytes) => signed.push(bytes)}
      />,
    );
    // Acknowledge + sign once under the first content.
    const ack = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ack) throw new Error("the acknowledge control did not render");
    fireEvent.click(ack);
    pointerHold(signButton(container), 850);
    expect(signed).toHaveLength(1);

    // The #22 content changes under a stable id+summary — a new, unacknowledged set.
    rerender(
      <PublishSheet
        target={target}
        payload={payload}
        variant={destinationVariant("other-pr")}
        ledger={after}
        onSign={(bytes) => signed.push(bytes)}
      />,
    );
    pointerHold(signButton(container), 850);
    expect(signed).toHaveLength(1); // still blocked — the stale ack must NOT carry over

    // Acknowledging the new content reopens signing.
    const ack2 = container.querySelector<HTMLInputElement>(".publish-sheet-ack-box");
    if (!ack2) throw new Error("the acknowledge control did not render after the swap");
    fireEvent.click(ack2);
    pointerHold(signButton(container), 850);
    expect(signed).toHaveLength(2);
  });
});

describe("own-branch performs ZERO Git/GitHub mutation", () => {
  it("signing own-branch only emits the submission bytes — it never creates a PR", () => {
    // The sheet has no Git/GitHub channel at all: its sole output is `onSign`. So a
    // sign PREVIEWS the submission (the bytes a later #21 create would send) and
    // mutates nothing. This asserts the emitted bytes are the submission preview and
    // that the sheet exposes no other side effect (there is no client to spy on
    // because there is none — creation is a separate act).
    const target = publishTarget("own-branch", draft, context);
    const payload = publishTargetPayload(target);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        target={target}
        payload={payload}
        variant={destinationVariant("own-branch")}
        onSign={(bytes) => signed.push(bytes)}
      />,
    );
    pointerHold(signButton(container), 850);
    expect(signed).toEqual([payload]);
    // The emitted bytes are a PR-submission PREVIEW (kind marker), not a create call.
    expect(JSON.parse(payload).kind).toBe("pr-submission");
    // The honest note names creation as a separate act — nothing is pushed here.
    expect(container.querySelector(".publish-sheet-pr-note")?.textContent).toContain(
      "separate act",
    );
  });
});

describe("target disagreement fails closed (issue #106): a payload/variant that disagrees with the target blocks signing", () => {
  // Defense-in-depth for R33 "what you see is what leaves". The paper renders the
  // structured card from `target` yet signs the INDEPENDENT `payload` under the
  // INDEPENDENT `variant`. When those diverge, the reviewer would see ONE artifact
  // (the card) while signing ANOTHER (the bytes) under a mislabelling frame — so the
  // sheet must fail CLOSED, emitting nothing on either sign path. Neutralising the
  // `targetBlocksSign` guard (or making `publishTargetAgrees` always return true)
  // reds every "blocked" assertion below; the positive control keeps a MATCHING
  // pair signing so the gate is not merely over-blocking.
  it("a payload that differs from publishTargetPayload(target) blocks BOTH sign paths", () => {
    const target = publishTarget("own-branch", draft, context);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        target={target}
        // A payload NOT equal to the target's canonical bytes — the disagreement.
        payload="TAMPERED::not-the-target-bytes::9c1"
        variant={destinationVariant("own-branch")}
        onSign={(bytes) => signed.push(bytes)}
      />,
    );
    // A completed pointer hold emits nothing.
    pointerHold(signButton(container), 850);
    expect(signed).toHaveLength(0);
    // The keyboard path is blocked too — even a completed hold emits nothing.
    const button = signButton(container);
    keyboardHold(button, 850);
    expect(signed).toHaveLength(0);
    // The sign control is disabled and the blocked state is announced (aria-legible).
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[data-testid="publish-mismatch"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="publish-mismatch"]')?.getAttribute("role")).toBe(
      "alert",
    );
  });

  it("a variant.mode that disagrees with target.mode blocks signing (right bytes, wrong frame)", () => {
    const target = publishTarget("own-branch", draft, context);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        target={target}
        // The bytes are correct for the own-branch target...
        payload={publishTargetPayload(target)}
        // ...but the sheet is framed as other-pr: a mislabelling disagreement.
        variant={destinationVariant("other-pr")}
        onSign={(bytes) => signed.push(bytes)}
      />,
    );
    pointerHold(signButton(container), 850);
    const button = signButton(container);
    keyboardHold(button, 850);
    expect(signed).toHaveLength(0);
    expect(button.disabled).toBe(true);
  });

  it("positive control: a MATCHING payload+variant+target still signs (not over-blocking)", () => {
    const target = publishTarget("own-branch", draft, context);
    const payload = publishTargetPayload(target);
    const signed: string[] = [];
    const { container } = mount(
      <PublishSheet
        target={target}
        payload={payload}
        variant={destinationVariant("own-branch")}
        onSign={(bytes) => signed.push(bytes)}
      />,
    );
    // No mismatch notice, button enabled, and a hold signs the exact bytes.
    expect(container.querySelector('[data-testid="publish-mismatch"]')).toBeNull();
    expect(signButton(container).disabled).toBe(false);
    pointerHold(signButton(container), 850);
    expect(signed).toEqual([payload]);
  });
});
