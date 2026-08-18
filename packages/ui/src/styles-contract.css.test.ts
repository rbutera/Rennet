import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-level CSS contracts for two review-fix invariants that a behavioural test can't
// see (happy-dom runs no CSS animations, and both 4px and 999px are ramp-legal so
// design-ramp.test.ts can't catch a radius reversion). These pin the exact declarations.

function declaration(css: string, selector: string): string {
  // Match at a rule boundary so `.publish-sheet-sign-fill` does not also match the longer
  // `.publish-sheet-sign.is-holding .publish-sheet-sign-fill` selector.
  const marker = `\n${selector} {`;
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("hold-to-sign fill CSS contract (critique P1-C)", () => {
  it("the resting fill is empty and inert — width 0, no animation", () => {
    const rule = declaration(styles, ".publish-sheet-sign-fill");
    expect(rule).toMatch(/width:\s*0;/);
    // The base rule must NOT arm the animation, or it would run on mount, not only on hold.
    expect(rule).not.toMatch(/animation-name/);
  });

  it("only the .is-holding state declares the fill animation", () => {
    const rule = declaration(styles, ".publish-sheet-sign.is-holding .publish-sheet-sign-fill");
    expect(rule).toMatch(/animation-name:\s*sign-hold-fill;/);
  });
});

describe("running-review progress track radius (critique review item 1)", () => {
  it("uses the 4px micro radius, not the 999px pill (DESIGN.md: pill = chips/counts only)", () => {
    expect(declaration(styles, ".canvas-primer-track")).toMatch(/border-radius:\s*4px;/);
    expect(declaration(styles, ".canvas-primer-track-fill")).toMatch(/border-radius:\s*4px;/);
  });
});
