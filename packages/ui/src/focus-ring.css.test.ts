import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The systemic focus ring (critique P1-B). DESIGN.md mandates a three-pixel GOLD
// ring; the one shared `:focus-visible` rule lives in index.css (the Tailwind
// entry stylesheet) and every control falls through to it. Bespoke per-component
// rings were the pre-overhaul failure mode this contract guards against.

const entry = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

describe("systemic focus ring (critique P1-B)", () => {
  it("defines one shared :focus-visible ring — 3px, gold accent token", () => {
    const start = entry.indexOf("\n  :focus-visible {");
    expect(start).toBeGreaterThanOrEqual(0);
    const rule = entry.slice(entry.indexOf("{", start), entry.indexOf("}", start));
    expect(rule).toMatch(/outline:\s*3px solid var\(--rn-accent-line\);/);
    expect(rule).toMatch(/outline-offset:/);
  });

  it("keeps NO bespoke covchip focus ring — it falls through to the systemic ring", () => {
    // The chip's old bespoke green ring contradicted the mandated ring; a
    // reversion re-adding a covchip-specific focus rule must fail here.
    expect(entry).not.toContain("ospec-covchip");
    const coverage = readFileSync(
      fileURLToPath(new URL("./components/openspec.tsx", import.meta.url)),
      "utf8",
    );
    expect(coverage).not.toMatch(/covchip[^"]*"[^"]*focus-visible:outline/);
  });
});
