// @vitest-environment happy-dom
//
// The Flagged lens (issue #138): this mounts the real `FlaggedLens` over derived
// indices and drives the surface — severity chips render, a concur row shows the
// vote count, a disagreement renders BOTH models' answers side by side and
// labelled, a row jumps to its anchor, and the empty vs failed states render
// LOUDLY differently. Assertions are behavioural (rendered text, recorded jumps),
// not presence-only.
import type { FlaggedReview } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { buildFlaggedIndex } from "../canvas/flagged";
import { mount } from "../test/dom";
import { FlaggedLens } from "./flagged";

const REVIEW: FlaggedReview = {
  status: "ok",
  findings: [
    {
      findingId: "f-high",
      anchor: "rennet:hunk/money-1",
      summary: "Budget is not consumed before the model call",
      severity: "high",
      agreement: { kind: "concur", agree: 3, total: 3 },
    },
    {
      findingId: "f-mid",
      anchor: "rennet:hunk/carry-2",
      summary: "Lossy-patch carry may slip a truncated span through",
      severity: "medium",
      agreement: {
        kind: "disagree",
        answers: [
          { model: "Claude", answer: "The truncated span is carried, this is a real leak" },
          { model: "Codex", answer: "The floor check catches it earlier, not a leak" },
        ],
      },
    },
    {
      findingId: "f-low",
      anchor: "rennet:hunk/style-3",
      summary: "Import ordering churn in one file",
      severity: "low",
      agreement: { kind: "concur", agree: 2, total: 2 },
    },
  ],
};

describe("FlaggedLens — the flagged index surface", () => {
  it("renders every flag with its severity chip, high first", () => {
    const { container } = mount(
      <FlaggedLens index={buildFlaggedIndex(REVIEW)} onJumpToAnchor={vi.fn()} />,
    );
    const severities = [...container.querySelectorAll(".flag")].map((el) =>
      el.getAttribute("data-severity"),
    );
    expect(severities).toEqual(["high", "medium", "low"]);
  });

  it("shows the concur vote count for an agreed flag", () => {
    const { getByText } = mount(
      <FlaggedLens index={buildFlaggedIndex(REVIEW)} onJumpToAnchor={vi.fn()} />,
    );
    expect(getByText(/both models concur 3\/3/)).toBeTruthy();
  });

  it("renders a disagreement as BOTH models' answers side by side, labelled", () => {
    const { container, getByText } = mount(
      <FlaggedLens index={buildFlaggedIndex(REVIEW)} onJumpToAnchor={vi.fn()} />,
    );
    const disagree = container.querySelector('[data-agreement="disagree"]');
    expect(disagree).toBeTruthy();
    const models = [...(disagree?.querySelectorAll(".flag-answer-model") ?? [])].map(
      (el) => el.textContent,
    );
    expect(models).toEqual(["Claude", "Codex"]);
    expect(getByText(/models disagree/)).toBeTruthy();
    expect(getByText(/real leak/)).toBeTruthy();
    expect(getByText(/not a leak/)).toBeTruthy();
  });

  it("jumps to the mark at a flag's anchor when the row is clicked", async () => {
    const onJump = vi.fn();
    const { container, user } = mount(
      <FlaggedLens index={buildFlaggedIndex(REVIEW)} onJumpToAnchor={onJump} />,
    );
    const jump = container.querySelector<HTMLButtonElement>(
      '[data-jump-anchor="rennet:hunk/carry-2"]',
    );
    if (!jump) throw new Error("expected a jump button for the medium flag");
    await user.click(jump);
    expect(onJump).toHaveBeenCalledWith("rennet:hunk/carry-2");
  });

  it("renders an honest EMPTY state for a review that ran and flagged nothing", () => {
    const { container, getByText } = mount(
      <FlaggedLens
        index={buildFlaggedIndex({ status: "ok", findings: [] })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    expect(container.querySelector(".flagged-empty")).toBeTruthy();
    expect(container.querySelector(".flagged-failed")).toBeNull();
    expect(getByText(/ran clean, it was not skipped/)).toBeTruthy();
  });

  it("renders a DISTINCT failed state for a runner that did not complete", () => {
    const { container, getByText } = mount(
      <FlaggedLens
        index={buildFlaggedIndex({ status: "failed", reason: "harness timed out" })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    expect(container.querySelector(".flagged-failed")).toBeTruthy();
    expect(container.querySelector(".flagged-empty")).toBeNull();
    expect(getByText(/Couldn't check/)).toBeTruthy();
    expect(getByText(/harness timed out/)).toBeTruthy();
  });

  // ── Dual-model (issue #191): the UI toggle. Dual is the DEFAULT; the control is
  // the OPT-DOWN to a single-Claude quick review (and back), never an opt-in. ──
  it("shows NO dual-model control when the affordance is not wired", () => {
    const { container } = mount(
      <FlaggedLens index={buildFlaggedIndex(REVIEW)} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.querySelector(".flag-deep-review")).toBeNull();
  });

  it("with dual ON (the default), offers a live opt-down to quick", async () => {
    const onToggle = vi.fn();
    const { container, user, getByText } = mount(
      <FlaggedLens
        index={buildFlaggedIndex(REVIEW)}
        onJumpToAnchor={vi.fn()}
        deepReview={{ active: true, onToggle }}
      />,
    );
    const button = container.querySelector<HTMLButtonElement>(".flag-deep-review");
    if (!button) throw new Error("expected the dual-model control");
    // Dual is on by default: the button is pressed, never disabled (it is a live toggle).
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(getByText("Dual review · switch to quick")).toBeTruthy();
    await user.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("with quick opted-down, offers a toggle back UP to dual", async () => {
    const onToggle = vi.fn();
    const { container, user, getByText } = mount(
      <FlaggedLens
        index={buildFlaggedIndex(REVIEW)}
        onJumpToAnchor={vi.fn()}
        deepReview={{ active: false, onToggle }}
      />,
    );
    const button = container.querySelector<HTMLButtonElement>(".flag-deep-review");
    if (!button) throw new Error("expected the dual-model control");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.disabled).toBe(false);
    expect(getByText("Quick review · switch to dual")).toBeTruthy();
    await user.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("badges a full two-seat reconcile with who ran", () => {
    const dualReview: FlaggedReview = {
      status: "ok",
      findings: REVIEW.status === "ok" ? REVIEW.findings : [],
      dual: { seats: ["Claude", "Codex"] },
    };
    const { container, getByText } = mount(
      <FlaggedLens index={buildFlaggedIndex(dualReview)} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.querySelector('[data-dual="full"]')).toBeTruthy();
    expect(getByText(/reconciled by Claude \+ Codex/)).toBeTruthy();
  });

  it("badges an HONEST single-provider degradation when the second seat was unavailable", () => {
    const degraded: FlaggedReview = {
      status: "ok",
      findings: REVIEW.status === "ok" ? REVIEW.findings : [],
      dual: { seats: ["Claude"], secondSeatUnavailable: "only one provider installed" },
    };
    const { container, getByText } = mount(
      <FlaggedLens index={buildFlaggedIndex(degraded)} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.querySelector('[data-dual="degraded"]')).toBeTruthy();
    expect(getByText(/single provider — no second opinion/)).toBeTruthy();
  });

  // ── The verification chip (issue #179): reproduce-or-refute evidence on the row.
  // A refuted finding never reaches the lens (core drops it), so the surface only
  // ever renders `reproduced` (confirmed) or `inconclusive` (an honest caveat). ──
  it("renders a reproduced verification chip WITH its evidence at the finding", () => {
    const review: FlaggedReview = {
      status: "ok",
      findings: [
        {
          findingId: "f-verified",
          anchor: "rennet:hunk/v-1",
          summary: "load() returns null and the result is dereferenced",
          severity: "high",
          agreement: { kind: "concur", agree: 1, total: 1 },
          verification: {
            verdict: "reproduced",
            evidence: "load() returns T | null at L12; L14 dereferences it unguarded",
          },
        },
      ],
    };
    const { container, getByText } = mount(
      <FlaggedLens index={buildFlaggedIndex(review)} onJumpToAnchor={vi.fn()} />,
    );
    const chip = container.querySelector('[data-verdict="reproduced"]');
    expect(chip).toBeTruthy();
    expect(chip?.classList.contains("flag-verification-reproduced")).toBe(true);
    expect(getByText("reproduced")).toBeTruthy();
    expect(getByText(/L14 dereferences it unguarded/)).toBeTruthy();
  });

  it("renders an inconclusive chip as an honest caveat, never a silent all-clear", () => {
    const review: FlaggedReview = {
      status: "ok",
      findings: [
        {
          findingId: "f-inconclusive",
          anchor: "rennet:hunk/v-2",
          summary: "a possible race between watcher and generator",
          severity: "medium",
          agreement: { kind: "concur", agree: 1, total: 1 },
          verification: {
            verdict: "inconclusive",
            evidence: "could not read the neighbouring file",
          },
        },
      ],
    };
    const { container, getByText } = mount(
      <FlaggedLens index={buildFlaggedIndex(review)} onJumpToAnchor={vi.fn()} />,
    );
    const chip = container.querySelector('[data-verdict="inconclusive"]');
    expect(chip).toBeTruthy();
    expect(chip?.classList.contains("flag-verification-inconclusive")).toBe(true);
    expect(getByText("couldn't verify")).toBeTruthy();
    expect(getByText(/could not read the neighbouring file/)).toBeTruthy();
  });

  it("renders NO verification chip on an unverified finding (additive, absent by default)", () => {
    const { container } = mount(
      <FlaggedLens index={buildFlaggedIndex(REVIEW)} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.querySelector(".flag-verification")).toBeNull();
  });
});
