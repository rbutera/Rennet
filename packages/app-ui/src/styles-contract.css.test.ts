import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-level contracts for review-fix invariants a behavioural test can't see (happy-dom
// runs no CSS animations, and both 4px and 999px are ramp-legal so design-ramp.test.ts can't
// catch a radius reversion). These pin the exact source declarations.

describe("the app stylesheet scans the vendored @rennet/ui kit", () => {
  // Tailwind v4 only generates utilities it finds in @source-scanned files, and it skips
  // node_modules — where the kit resolves as a workspace symlink. The kit writes the shadcn
  // vocabulary this app never types itself (the radius aliases rounded-lg…, bg-primary, the
  // button brightness hovers). Without an @source at the kit's real path those classes are
  // never emitted and every kit Button/Input renders with Tailwind preflight's
  // border-radius:0 — square, no gold fill. RED-proof: delete the kit @source line and this
  // fires. Guards the "square buttons" regression that shipped once already.
  const css = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

  it("declares an @source pointing at packages/ui/src/components", () => {
    expect(css).toMatch(/@source\s+"[^"]*\bui\/src\/components"/);
  });

  // RED-proof for the titlebar-overlap regression: the shell's h-14 titlebar and its pt-14
  // content offset live in ./app/shell.tsx. A named glob (@source "./app.tsx") stopped
  // covering that file when Wave 4.1 split the monolith into ./app/, so pt-14 was never
  // generated and the fixed titlebar overlapped the view. Scan the whole tree so a future
  // move can't drop a file's utilities again. Revert to a single-file glob and this fires.
  it("scans the whole app-ui source tree, not a single named file", () => {
    expect(css).toMatch(/@source\s+"\.\/"/);
  });
});

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
