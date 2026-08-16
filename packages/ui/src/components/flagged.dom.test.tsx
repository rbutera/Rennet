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
    // No blocking states ⇒ no disclosure (the honest all-clear is unqualified).
    expect(container.querySelector(".flagged-blocked-ingestion")).toBeNull();
  });

  it("does NOT claim 'ran clean' when ingestion was blocked, and discloses each blocker (R18/#309)", () => {
    const { container, getByText, queryByText } = mount(
      <FlaggedLens
        index={buildFlaggedIndex({
          status: "ok",
          findings: [],
          blockingStates: [
            {
              reason: "binary",
              path: "assets/logo.png",
              detail: "assets/logo.png: binary file; its content is not text-diffable.",
            },
            {
              reason: "truncated",
              path: null,
              detail: "The captured diff was truncated at the size cap; the tail was not ingested.",
            },
          ],
        })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    // The unqualified all-clear is UNREACHABLE over blocked ingestion.
    expect(queryByText(/ran clean, it was not skipped/)).toBeNull();
    // The qualified empty state says nothing was flagged in WHAT COULD BE READ.
    expect(getByText(/Nothing was flagged in what could be read/)).toBeTruthy();
    // The disclosure lists every blocker with its reason and detail.
    const disclosure = container.querySelector(".flagged-blocked-ingestion");
    expect(disclosure).toBeTruthy();
    const items = [...(disclosure?.querySelectorAll(".flagged-blocked-item") ?? [])];
    expect(items.map((el) => el.getAttribute("data-reason"))).toEqual(["binary", "truncated"]);
    expect(getByText(/binary file; its content is not text-diffable/)).toBeTruthy();
    expect(getByText(/the tail was not ingested/)).toBeTruthy();
  });

  it("discloses blocked ingestion BESIDE findings — an absence of findings over un-ingested content is not an all-clear (#309)", () => {
    const { container } = mount(
      <FlaggedLens
        index={buildFlaggedIndex({
          ...REVIEW,
          blockingStates: [
            {
              reason: "submodule",
              path: "vendor/dep",
              detail: "vendor/dep: submodule change; the child repo's content is not in this diff.",
            },
          ],
        })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    // Findings still render AND the disclosure renders beside them.
    expect(container.querySelectorAll(".flag").length).toBe(3);
    expect(container.querySelector(".flagged-blocked-ingestion")).toBeTruthy();
    expect(container.querySelector('[data-reason="submodule"]')).toBeTruthy();
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

  it("renders passing CI, no checks, unavailable, and absent as four distinct surfaces", () => {
    const passing = mount(
      <FlaggedLens
        index={buildFlaggedIndex({
          status: "ok",
          findings: [],
          ciSignal: {
            status: "checked",
            overall: "passing",
            failures: [],
            headOid: "passing-head",
            incomplete: false,
          },
        })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    expect(passing.getByText("CI: all checks passing on the reviewed head")).toBeTruthy();

    const noChecks = mount(
      <FlaggedLens
        index={buildFlaggedIndex({
          status: "ok",
          findings: [],
          ciSignal: { status: "no-checks", headOid: "empty-head" },
        })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    expect(noChecks.getByText("no CI checks reported for the reviewed head")).toBeTruthy();
    expect(noChecks.container.textContent).not.toContain(
      "CI: all checks passing on the reviewed head",
    );

    const unavailable = mount(
      <FlaggedLens
        index={buildFlaggedIndex({
          status: "ok",
          findings: [],
          ciSignal: { status: "unavailable", reason: "GitHub timed out" },
        })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    expect(unavailable.getByText("CI status unavailable — GitHub timed out")).toBeTruthy();

    const absent = mount(
      <FlaggedLens
        index={buildFlaggedIndex({ status: "ok", findings: [] })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    expect(absent.container.querySelector(".ci-signal-panel")).toBeNull();
  });

  it("shows attributed failures without duplicating change-caused finding text", () => {
    const { container, getByText, queryByText } = mount(
      <FlaggedLens
        index={buildFlaggedIndex({
          status: "ok",
          findings: [],
          ciSignal: {
            status: "checked",
            overall: "failing",
            headOid: "red-head",
            incomplete: true,
            failures: [
              {
                checkId: "check:core-test",
                checkName: "core:test",
                verdict: "change-caused",
                evidence: "packages/core/src/pipeline.test.ts failed",
                implicatedPaths: ["packages/core/src/pipeline.ts"],
                classifiedBy: "deterministic",
                findingId: "ci-finding-core-test",
              },
              {
                checkId: "check:hosted-runner",
                checkName: "hosted runner",
                verdict: "environmental",
                evidence: "runner lost communication",
                implicatedPaths: [],
                classifiedBy: "deterministic",
              },
              {
                checkId: "check:acceptance",
                checkName: "acceptance",
                verdict: "unclassified",
                evidence: "snapshot mismatch",
                implicatedPaths: [],
                classifiedBy: "deterministic",
              },
            ],
          },
        })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    const panel = container.querySelector<HTMLDetailsElement>(".ci-signal-panel");
    expect(panel?.open).toBe(true);
    expect(
      getByText("1 change-caused CI failure appears in the flagged findings below"),
    ).toBeTruthy();
    expect(getByText("environmental (infra)")).toBeTruthy();
    expect(getByText("Rennet could not attribute this — check it yourself")).toBeTruthy();
    expect(
      getByText("CI results are incomplete — omitted checks may still be failing"),
    ).toBeTruthy();
    expect(queryByText("packages/core/src/pipeline.test.ts failed")).toBeNull();
  });

  it("keeps unplaced change-caused failures visible and keys same-named checks by forge identity", () => {
    const { container, getByText, getAllByText } = mount(
      <FlaggedLens
        index={buildFlaggedIndex({
          status: "ok",
          findings: [],
          ciSignal: {
            status: "checked",
            overall: "failing",
            headOid: "red-head",
            incomplete: false,
            failures: [
              {
                checkId: "workflow-a/check-1",
                checkName: "test",
                verdict: "change-caused",
                evidence: "mechanical failure without an offered hunk",
                implicatedPaths: ["generated/output.ts"],
                detailsUrl: "https://example.test/check/a",
                classifiedBy: "deterministic",
              },
              {
                checkId: "workflow-b/check-1",
                checkName: "test",
                verdict: "change-caused",
                evidence: "model refinement could not supply a location",
                implicatedPaths: [],
                detailsUrl: "https://example.test/check/b",
                classifiedBy: "model",
              },
            ],
          },
        })}
        onJumpToAnchor={vi.fn()}
      />,
    );

    expect(getAllByText("test")).toHaveLength(2);
    expect(getAllByText("change-caused CI failure (no offered hunk to place it on)")).toHaveLength(
      2,
    );
    expect(getByText("mechanical failure without an offered hunk")).toBeTruthy();
    expect(getByText("model refinement could not supply a location")).toBeTruthy();
    expect(container.querySelectorAll(".ci-signal-failure")).toHaveLength(2);
    expect(container.querySelectorAll(".ci-signal-details")).toHaveLength(2);
    expect(container.textContent).not.toContain("appears in the flagged findings below");
  });

  it("shows CI state even when the model review failed", () => {
    const { getByText } = mount(
      <FlaggedLens
        index={buildFlaggedIndex({
          status: "failed",
          reason: "model unavailable",
          ciSignal: { status: "unavailable", reason: "forge unavailable" },
        })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    expect(getByText("CI status unavailable — forge unavailable")).toBeTruthy();
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
