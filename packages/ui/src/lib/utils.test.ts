import { describe, expect, it } from "vitest";
import { cn } from "./utils";

// The defect this pins: bare twMerge filed Rennet's ramp steps under text-COLOR,
// so `cn("text-10", "text-primary")` returned just "text-primary" and wave-2's
// ramp sweep silently never took at ~20 call sites. Every ramp step is asserted
// so a newly minted step that misses the classGroups registration reddens here.
describe("cn — Rennet ramp sizes survive a colour merge", () => {
  const RAMP = ["text-10", "text-2xs", "text-12-5", "text-13", "text-15", "text-display"];

  it("keeps each ramp size alongside a text colour", () => {
    for (const size of RAMP) {
      expect(cn(size, "text-primary")).toBe(`${size} text-primary`);
      expect(cn("text-primary", size)).toBe(`text-primary ${size}`);
    }
  });

  it("still merges two sizes to the later one", () => {
    expect(cn("text-13", "text-15")).toBe("text-15");
    expect(cn("text-sm", "text-13")).toBe("text-13");
  });

  it("still merges two colours to the later one", () => {
    expect(cn("text-primary", "text-muted-foreground")).toBe("text-muted-foreground");
  });
});
