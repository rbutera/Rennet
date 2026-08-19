// @vitest-environment happy-dom
//
// The conversation panel's flat `PanelSurface` stream (with its collapsed/expanded
// both-answer overrides) was retired when the review heart adopted the aligned margin
// (issue #356). The surviving two-column comparison contract belongs to the GLOBAL
// `AskAnswers` surface (still rendered by the OpenSpec viewer): when the reviewer asks
// BOTH models, the two labelled answers render side by side with no synthesis card.
//
// This used to be pinned by reading a `grid-template-columns: 1fr 1fr` rule out of
// `canvas.css`. That CSS was deleted in the Tailwind overhaul, and the layout is now a
// utility on the tsx — so the contract is asserted where it actually lives: the rendered
// DOM. A `both` result carries `data-count="2"` and renders two `.ask-answer-card`s inside
// `.ask-answer-cards`; an orchestrator-only result renders one. That is the two-column
// comparison, independent of which CSS mechanism lays it out.
import { parseCommandOutput } from "@rennet/protocol";
import type { AskReviewResult } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { AskAnswers } from "./ask";

// Validated through the REAL protocol boundary — the exact shape `review.ask` returns.
const BOTH_RESULT = parseCommandOutput("review.ask", {
  mode: "both",
  primary: { model: "Orchestrator · Claude", answer: "milliseconds — worth a rename" },
  secondOpinion: { model: "codex", answer: "milliseconds; the client divides by 1000 on read" },
}) as AskReviewResult;

const ORCHESTRATOR_RESULT = parseCommandOutput("review.ask", {
  mode: "orchestrator",
  primary: { model: "Orchestrator · Claude", answer: "milliseconds — worth a rename" },
}) as AskReviewResult;

describe("AskAnswers two-column comparison contract", () => {
  it("renders both answers as two side-by-side cards for global consumers (the OpenSpec viewer)", () => {
    const { container } = mount(<AskAnswers question="what unit?" result={BOTH_RESULT} />);
    const answers = container.querySelector(".ask-answers");
    expect(answers?.getAttribute("data-count")).toBe("2");
    const cards = container.querySelectorAll(".ask-answer-cards .ask-answer-card");
    expect(cards).toHaveLength(2);
    // The side-by-side mechanism itself (review finding: two cards alone would
    // still pass while stacking): the answers wrapper is the `group` whose
    // data-count drives the card grid's two-column variant. happy-dom computes
    // no layout, so the utility contract is the observable truth.
    expect(answers?.className).toContain("group");
    const grid = container.querySelector(".ask-answer-cards");
    expect(grid?.className).toContain("group-data-[count=2]:grid-cols-2");
  });

  it("renders a single card when only the orchestrator answered", () => {
    const { container } = mount(<AskAnswers question="what unit?" result={ORCHESTRATOR_RESULT} />);
    const answers = container.querySelector(".ask-answers");
    expect(answers?.getAttribute("data-count")).toBe("1");
    expect(container.querySelectorAll(".ask-answer-cards .ask-answer-card")).toHaveLength(1);
  });
});
