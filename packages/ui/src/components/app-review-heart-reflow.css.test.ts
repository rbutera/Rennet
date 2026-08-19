import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The "diff never reflows" guarantee (issue #36 → #356) rests on ONE layout contract: in the
// review-heart flex split the conversation rail sibling is FIXED-WIDTH (an explicit width +
// shrink-0) and the diff column takes the remainder (flex-1 min-w-0). Growing or aligning a
// thread then changes only the rail's own box — it can never steal width from the diff.
//
// happy-dom does no real layout, so the DOM test (app-review-heart-align) asserts transform-
// only shifts under mocked geometry. This source contract is the other half: post-Tailwind the
// declarations ride utility classNames, so the contract reads the component sources and pins
// the utilities. Flipping the rail to flexible (or letting the diff column shrink to zero)
// reddens here.

const app = readFileSync(fileURLToPath(new URL("../app.tsx", import.meta.url)), "utf8");
const panel = readFileSync(
  fileURLToPath(new URL("./conversation-panel.tsx", import.meta.url)),
  "utf8",
);

describe("review-heart split: the fixed-width rail sibling contract (no reflow)", () => {
  it("pins the diff column as the flexible remainder that can shrink", () => {
    const diff = app.match(/className="diff-column[^"]*"/)?.[0] ?? "";
    expect(diff).toContain("flex-1");
    expect(diff).toContain("min-w-0");
  });

  it("keeps the conversation rail sibling fixed-width, never flexible", () => {
    const shell = panel.match(/className="conversation-panel-shell[^"]*"/)?.[0] ?? "";
    expect(shell).toMatch(/w-\[\d+px\]/);
    expect(shell).toContain("shrink-0");
    expect(shell).not.toContain("flex-1");
  });
});
