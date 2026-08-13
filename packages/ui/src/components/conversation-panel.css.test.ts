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

  it("stacks two cards in the shell and uses two columns only when the panel is expanded", () => {
    expect(declaration(canvas, '.ask-answers[data-count="2"] .ask-answer-cards')).toContain(
      "grid-template-columns: 1fr",
    );
    expect(
      declaration(
        styles,
        '.conversation-panel--expanded .ask-answers[data-count="2"] .ask-answer-cards',
      ),
    ).toContain("grid-template-columns: 1fr 1fr");
  });
});
