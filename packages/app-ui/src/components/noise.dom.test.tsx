// @vitest-environment happy-dom
//
// The Noise lens (issue #34): this mounts the real `NoiseLens` over derived indices
// and drives the surface — groups render COLLAPSED with a category + plain-speech
// summary + a judged-by chip (rule vs noise job, distinguishable); expanding a group
// shows its churn items (inspectable — the totality floor); a "not noise?" control
// pulls a group into the review and it can be re-grouped; a deviating line is shown
// EJECTED above the fold; and the empty vs failed states render LOUDLY differently.
// Assertions are behavioural (rendered text, recorded jumps, toggled state), not
// presence-only.
import type { NoiseReview } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { buildNoiseIndex } from "../canvas/noise";
import { mount } from "../test/dom";
import { NoiseLens } from "./noise";

const REVIEW: NoiseReview = {
  status: "ok",
  groups: [
    {
      groupId: "noise-formatting",
      category: "formatting",
      summary: "Whitespace and formatting only; no code changed.",
      judgedBy: { kind: "rule", rule: "formatting-only" },
      items: [
        { anchor: "rennet:hunk/fmt-1", detail: "src/app.tsx reflowed" },
        { anchor: "rennet:hunk/fmt-2", detail: "src/store.ts trimmed" },
      ],
    },
    {
      groupId: "noise-imports",
      category: "import-order",
      summary: "Imports reordered; no symbol added or removed.",
      judgedBy: { kind: "noise-job", model: "Claude" },
      items: [
        { anchor: "rennet:hunk/imp-1", detail: "sorted alphabetically" },
        {
          anchor: "rennet:hunk/imp-deviant",
          detail: "added `import { chargeCard }` — a real new dependency",
          deviates: true,
        },
      ],
    },
  ],
};

describe("NoiseLens — the noise index surface", () => {
  it("renders each group with its category, plain-speech summary, and a judged-by chip", () => {
    const { container, getByText } = mount(
      <NoiseLens index={buildNoiseIndex(REVIEW)} onJumpToAnchor={vi.fn()} />,
    );
    const categories = [...container.querySelectorAll(".noise-group")].map((el) =>
      el.getAttribute("data-category"),
    );
    expect(categories).toEqual(["formatting", "import-order"]);
    expect(getByText(/Dependency graph unchanged|Whitespace and formatting only/)).toBeTruthy();
  });

  it("distinguishes a RULE-judged group from a NOISE-JOB-judged group by its chip", () => {
    const { container } = mount(
      <NoiseLens index={buildNoiseIndex(REVIEW)} onJumpToAnchor={vi.fn()} />,
    );
    const judges = [...container.querySelectorAll(".noise-judge")].map((el) =>
      el.getAttribute("data-judge"),
    );
    expect(judges).toEqual(["rule", "noise-job"]);
    // The rule chip names its mechanical rule; the noise-job chip names the model.
    expect(container.querySelector('[data-judge="rule"]')?.textContent).toContain(
      "formatting-only",
    );
    expect(container.querySelector('[data-judge="noise-job"]')?.textContent).toContain("Claude");
  });

  it("keeps the churn INSPECTABLE: a group is collapsed, expand reveals its items", async () => {
    const { container, user } = mount(
      <NoiseLens index={buildNoiseIndex(REVIEW)} onJumpToAnchor={vi.fn()} />,
    );
    // Collapsed by default — no items list rendered.
    expect(container.querySelector(".noise-items")).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(".noise-group-toggle");
    if (!toggle) throw new Error("expected a group toggle");
    await user.click(toggle);
    const items = [...container.querySelectorAll(".noise-item")];
    expect(items.length).toBeGreaterThan(0);
    // The formatting group's two suppressed lines are now visible.
    expect(container.textContent).toContain("src/app.tsx reflowed");
  });

  it("jumps to the mark at a churn item's anchor when it is clicked", async () => {
    const onJump = vi.fn();
    const { container, user } = mount(
      <NoiseLens index={buildNoiseIndex(REVIEW)} onJumpToAnchor={onJump} />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(".noise-group-toggle");
    if (!toggle) throw new Error("expected a group toggle");
    await user.click(toggle);
    const jump = container.querySelector<HTMLButtonElement>(
      '[data-jump-anchor="rennet:hunk/fmt-1"]',
    );
    if (!jump) throw new Error("expected a jump button for the first item");
    await user.click(jump);
    expect(onJump).toHaveBeenCalledWith("rennet:hunk/fmt-1");
  });

  it("surfaces a DEVIATING line as ejected into the review, above the fold, and jumps to it", async () => {
    const onJump = vi.fn();
    const { container, getByText, user } = mount(
      <NoiseLens index={buildNoiseIndex(REVIEW)} onJumpToAnchor={onJump} />,
    );
    const ejected = container.querySelector(".noise-ejected");
    expect(ejected).toBeTruthy();
    expect(getByText(/broke a group's pattern/)).toBeTruthy();
    const jump = ejected?.querySelector<HTMLButtonElement>(
      '[data-jump-anchor="rennet:hunk/imp-deviant"]',
    );
    if (!jump) throw new Error("expected the ejected line to jump");
    await user.click(jump);
    expect(onJump).toHaveBeenCalledWith("rennet:hunk/imp-deviant");
  });

  it("pulls a group back into the review ('not noise?') and can re-group it (reversible)", async () => {
    const { container, user } = mount(
      <NoiseLens index={buildNoiseIndex(REVIEW)} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.querySelectorAll(".noise-group")).toHaveLength(2);
    const pullback = container.querySelector<HTMLButtonElement>(
      '[data-pullback="noise-formatting"]',
    );
    if (!pullback) throw new Error("expected a pull-back control");
    await user.click(pullback);
    // The pulled-back group leaves the noise fold and shows in the pulled section.
    expect(container.querySelectorAll(".noise-group")).toHaveLength(1);
    expect(container.querySelector(".noise-pulled")).toBeTruthy();
    // The pulled section names the group pulled back (distinct from the ejected banner).
    expect(container.querySelector(".noise-pulled-head")?.textContent).toMatch(
      /pulled into the review/,
    );
    // Reversible: re-group it as noise.
    const regroup = container.querySelector<HTMLButtonElement>('[data-regroup="noise-formatting"]');
    if (!regroup) throw new Error("expected a re-group control");
    await user.click(regroup);
    expect(container.querySelectorAll(".noise-group")).toHaveLength(2);
    expect(container.querySelector(".noise-pulled")).toBeNull();
  });

  it("renders an honest EMPTY state for a review that ran and grouped nothing", () => {
    const { container, getByText } = mount(
      <NoiseLens index={buildNoiseIndex({ status: "ok", groups: [] })} onJumpToAnchor={vi.fn()} />,
    );
    expect(container.querySelector(".noise-empty")).toBeTruthy();
    expect(container.querySelector(".noise-failed")).toBeNull();
    expect(getByText(/ran clean, it was not skipped/)).toBeTruthy();
  });

  it("renders a DISTINCT failed state for a runner that did not complete", () => {
    const { container, getByText } = mount(
      <NoiseLens
        index={buildNoiseIndex({ status: "failed", reason: "noise runner timed out" })}
        onJumpToAnchor={vi.fn()}
      />,
    );
    expect(container.querySelector(".noise-failed")).toBeTruthy();
    expect(container.querySelector(".noise-empty")).toBeNull();
    expect(getByText(/Couldn't check/)).toBeTruthy();
    expect(getByText(/noise runner timed out/)).toBeTruthy();
  });
});
