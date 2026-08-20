import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-level contracts for review-fix invariants a behavioural test can't see (happy-dom
// runs no CSS animations, and both 4px and 999px are ramp-legal so design-ramp.test.ts can't
// catch a radius reversion). These pin the exact source declarations.

describe("hold-to-sign fill contract (critique P1-C)", () => {
  // Post-Tailwind conversion the fill's resting geometry rides utilities on the component
  // and the sign-hold-fill KEYFRAME + its `.is-holding` arming rule live in index.css (a
  // "report, don't inline" keyframe). styles.css is deleted, so the two invariants it pinned
  // are now pinned against the COMPONENT SOURCE: the fill is inert at rest (width 0, no
  // animation), and only the hold state arms it. The runtime toggling of `.is-holding` is
  // exercised behaviourally in publish-hold-progress.dom.test.tsx.
  const component = readFileSync(
    fileURLToPath(new URL("./components/publish-sheet.tsx", import.meta.url)),
    "utf8",
  );

  it("the resting fill is empty and inert — width 0, no animation utility", () => {
    // The fill span's utility class list carries `w-0` (resting width 0) and arms no
    // animation. RED-proof: change `w-0` to `w-full`, or add an `animate-*`, and this fires.
    const fill = /className="(publish-sheet-sign-fill[^"]*)"/.exec(component)?.[1] ?? "";
    expect(fill).toMatch(/\bw-0\b/);
    expect(fill).not.toMatch(/\banimate-/);
    expect(fill).not.toContain("is-holding");
  });

  it("only the hold state arms the fill — `.is-holding` is applied conditionally", () => {
    // The `.is-holding` class (which arms the CSS animation in index.css) is added ONLY when
    // the button is holding, never statically. RED-proof: put `is-holding` in the base class
    // list and drop the conditional and this fires.
    expect(component).toMatch(/holding \? " is-holding" : ""/);
    expect(component).not.toMatch(/publish-sheet-sign [^"]*\bis-holding\b/);
  });
});

describe("running-review progress track radius (critique review item 1)", () => {
  // Re-pinned against the component source after the Tailwind conversion (styles.css is
  // deleted): the track and its fill carry the 4px micro radius utility, never the pill.
  const source = readFileSync(
    fileURLToPath(new URL("./components/running-review.tsx", import.meta.url)),
    "utf8",
  );

  it("uses the 4px micro radius, not the 999px pill (DESIGN.md: pill = chips/counts only)", () => {
    const track = source.match(/className="canvas-primer-track[^-][^"]*"/)?.[0] ?? "";
    const fill = source.match(/className="canvas-primer-track-fill[^"]*"/)?.[0] ?? "";
    expect(track).toContain("rounded-micro");
    expect(fill).toContain("rounded-micro");
    expect(track).not.toContain("rounded-full");
    expect(fill).not.toContain("rounded-full");
  });
});
