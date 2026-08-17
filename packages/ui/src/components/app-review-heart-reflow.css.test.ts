import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The "diff never reflows" guarantee (issue #36 → #356) rests on ONE layout contract: in the
// review-heart flex split the rail sibling is FIXED-WIDTH (`flex: none`, an explicit width) and
// the diff column takes the remainder (`flex: 1 1 auto; min-width: 0`). Growing or aligning a
// thread then changes only the rail's own box — it can never steal width from the diff, so the
// diff's rows keep their positions.
//
// Deliberate scope: happy-dom does no real layout, so the DOM test (app-review-heart-align) can
// only assert the panel positions with a TRANSFORM (never a margin/top shift) and that diff node
// tops are unchanged under mocked geometry — true by construction there. This CSS-contract test is
// the OTHER half of the guard: it reads the stylesheet and pins the fixed-width sibling rule, so
// flipping the rail sibling from fixed to flexible (which real layout would let steal diff width)
// reddens here. A real-browser layout assertion is not a lane this repo has.
function declaration(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

const styles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
const canvas = readFileSync(fileURLToPath(new URL("../canvas.css", import.meta.url)), "utf8");

describe("review-heart split: the fixed-width rail sibling contract (no reflow)", () => {
  it("pins the diff column as the flexible remainder that can shrink", () => {
    const diff = declaration(canvas, ".review-heart-split .diff-column");
    expect(diff).toMatch(/flex:\s*1 1 auto/);
    expect(diff).toMatch(/min-width:\s*0/);
  });

  it("keeps the conversation-host rail sibling fixed-width, never flexible", () => {
    const host = declaration(canvas, ".review-heart-split > .conversation-host");
    expect(host).toMatch(/flex:\s*none/);
    expect(host).toMatch(/width:\s*340px/);
  });

  it("keeps the conversation-panel-shell rail sibling fixed-width, never flexible", () => {
    const shell = declaration(styles, ".review-heart-split > .conversation-panel-shell");
    expect(shell).toMatch(/flex:\s*none/);
    expect(shell).toMatch(/width:\s*340px/);
  });
});
