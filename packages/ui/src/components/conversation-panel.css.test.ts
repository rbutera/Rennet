import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function declaration(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

// The conversation panel's flat `PanelSurface` stream (with its collapsed/expanded
// both-answer overrides) was retired when the review heart adopted the aligned margin
// (issue #356). The surviving `.ask-answers[data-count="2"]` two-column rule belongs to
// the GLOBAL comparison surface (`AskAnswers`), still rendered by the OpenSpec viewer —
// so this is the contract that must hold.
describe("AskAnswers two-column comparison contract", () => {
  const canvas = readFileSync(fileURLToPath(new URL("../canvas.css", import.meta.url)), "utf8");

  it("keeps global consumers such as the OpenSpec viewer two-column", () => {
    expect(declaration(canvas, '.ask-answers[data-count="2"] .ask-answer-cards')).toMatch(
      /grid-template-columns:\s*1fr 1fr;/,
    );
  });
});
