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

describe("ConversationPanel both-answer width contract", () => {
  const canvas = readFileSync(fileURLToPath(new URL("../canvas.css", import.meta.url)), "utf8");
  const styles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
  const collapsedSelector = '.conversation-panel .ask-answers[data-count="2"] .ask-answer-cards';
  const expandedSelector =
    '.conversation-panel--expanded .ask-answers[data-count="2"] .ask-answer-cards';

  it("keeps global consumers such as OpenSpec two-column", () => {
    expect(declaration(canvas, '.ask-answers[data-count="2"] .ask-answer-cards')).toMatch(
      /grid-template-columns:\s*1fr 1fr;/,
    );
  });

  it("stacks the two cards in the collapsed conversation panel", () => {
    expect(declaration(styles, collapsedSelector)).toMatch(/grid-template-columns:\s*1fr;/);
  });

  it("restores two columns after the collapsed rule when the panel is expanded", () => {
    expect(declaration(styles, expandedSelector)).toMatch(/grid-template-columns:\s*1fr 1fr;/);
    expect(styles.indexOf(expandedSelector)).toBeGreaterThan(styles.indexOf(collapsedSelector));
  });
});
