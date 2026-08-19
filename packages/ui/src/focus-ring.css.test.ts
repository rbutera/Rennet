import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The systemic focus ring (critique P1-B). DESIGN.md mandates a three-pixel GOLD
// ring; the one shared `:focus-visible` rule lives in index.css (the Tailwind
// entry stylesheet) and every control falls through to it. Two review findings
// hardened this contract: the ring must be the SOLID accent (the translucent
// accent-line token fails the 3:1 focus-indicator floor when composited), and
// the full-viewport `.canvas-app` keyboard region must draw its ring INSET (an
// outset ring on a min-h-screen element clips off-screen).

const entry = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

describe("systemic focus ring (critique P1-B)", () => {
  it("defines one shared :focus-visible ring — 3px, SOLID gold accent", () => {
    expect(entry).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--rn-accent\);[^}]*\}/,
    );
    // The translucent line token is a border color, never the ring.
    expect(entry).not.toMatch(/:focus-visible\s*\{[^}]*var\(--rn-accent-line\)/);
  });

  it("keeps the keyboard canvas region's ring inset so it stays on screen", () => {
    expect(entry).toMatch(/\.canvas-app:focus-visible\s*\{[^}]*outline-offset:\s*-3px;[^}]*\}/);
  });

  it("keeps NO bespoke covchip focus ring — it falls through to the systemic ring", () => {
    expect(entry).not.toContain("ospec-covchip");
    const coverage = readFileSync(
      fileURLToPath(new URL("./components/openspec.tsx", import.meta.url)),
      "utf8",
    );
    expect(coverage).not.toMatch(/covchip[^"]*"[^"]*focus-visible:outline/);
  });
});
