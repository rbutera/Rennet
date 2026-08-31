import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The systemic focus ring (critique P1-B). DESIGN.md mandates a three-pixel GOLD
// ring; the one shared `:focus-visible` rule lives in index.css (the Tailwind
// entry stylesheet) and every control falls through to it. Two review findings
// hardened this contract: the ring must be the SOLID accent (the translucent
// accent-line token fails the 3:1 focus-indicator floor when composited).
//
// The second hardening — an INSET ring for the full-viewport `.canvas-app` keyboard
// region — outlived its subject. No element has carried `canvas-app` since the canvas
// era ended (B2, #489); the rule and the assertion pinning it were both describing a
// class the app no longer renders, and a rule that matches nothing cannot fail.

const entry = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

describe("systemic focus ring (critique P1-B)", () => {
  it("defines one shared :focus-visible ring — 3px, SOLID gold accent", () => {
    expect(entry).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--rn-accent\);[^}]*\}/,
    );
    // The translucent line token is a border color, never the ring.
    expect(entry).not.toMatch(/:focus-visible\s*\{[^}]*var\(--rn-accent-line\)/);
  });

  it("keeps NO bespoke covchip focus ring in the stylesheet — it falls through to the systemic ring", () => {
    // The Spec view's `openspec.tsx` component (which carried the covchip) was deleted in
    // the B2 cutover (#489); the systemic-ring invariant now stands on the stylesheet alone.
    expect(entry).not.toContain("ospec-covchip");
  });
});
