import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The systemic focus ring (critique P1-B). DESIGN.md mandates "a three-pixel review-blue
// ring", and before this the `.canvas-app` region (role=application) and most controls
// had no visible focus. This is a CONTRACT test: the one shared `:focus-visible` rule and
// the canvas-region rule must exist, keyed on the review-blue accent token and 3px.

function declaration(css: string, selector: string): string {
  // Match the selector at a rule boundary so `:focus-visible` doesn't match a longer
  // selector like `.foo:focus-visible`.
  const marker = `\n${selector} {`;
  const start = css.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

describe("systemic focus ring (critique P1-B)", () => {
  const canvas = readFileSync(fileURLToPath(new URL("./canvas.css", import.meta.url)), "utf8");

  it("defines one shared :focus-visible ring — 3px, review-blue accent token", () => {
    const rule = declaration(canvas, ":focus-visible");
    expect(rule).toMatch(/outline:\s*3px solid var\(--accent\);/);
    expect(rule).toMatch(/outline-offset:\s*2px;/);
  });

  it("gives the keyboard-driven canvas region its own inset ring", () => {
    const rule = declaration(canvas, ".canvas-app:focus-visible");
    expect(rule).toMatch(/outline-offset:\s*-3px;/);
  });

  it("still zeroes the region's resting outline (the ring is focus-only)", () => {
    expect(canvas).toMatch(/\.canvas-app\s*{[^}]*outline:\s*none;/s);
  });

  it("keeps NO bespoke focus ring on the coverage chip — it falls through to the systemic ring", () => {
    // The chip's old `outline: 2px solid var(--green)` focus ring contradicted the one
    // mandated 3px review-blue ring; a reversion re-adding any covchip :focus-visible rule
    // must fail here.
    expect(canvas).not.toMatch(/\.ospec-covchip:focus-visible/);
  });
});
