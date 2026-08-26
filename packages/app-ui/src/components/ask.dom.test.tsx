// @vitest-environment happy-dom
//
// The Ask surface (issue #139): mounts the real `AskControl` + `AskAnswers` and
// drives them. The caret opens the routing menu; picking "ask both" is a per-message
// mode change (remembered per thread by the parent, never global); pressing Ask
// sends; and a "both" result renders TWO labelled cards side by side with the
// "no synthesis block" footer, while an orchestrator result renders ONE. The result
// fixture is validated against the REAL `@rennet/protocol` schema before it is
// rendered, so the surface is driven by a fixture behind the real typed boundary.
// Assertions are behavioural (rendered text, recorded callbacks), not presence-only.

import type { AskReviewResult } from "@rennet/protocol";
import { parseCommandOutput } from "@rennet/protocol";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { type AskModeByThread, askModeForThread, rememberAskMode } from "../canvas/ask";
import { mount } from "../test/dom";
import { AskAnswers, AskControl } from "./ask";

/** Query an element and fail loudly if it is missing (no non-null assertions). */
function need<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`expected an element matching ${selector}`);
  return el;
}

// Validated through the REAL protocol boundary — the exact shape `review.ask` returns.
const ORCHESTRATOR_RESULT = parseCommandOutput("review.ask", {
  mode: "orchestrator",
  primary: {
    model: "Orchestrator · Claude",
    answer: "milliseconds — worth a rename, not a behaviour change",
  },
}) as AskReviewResult;

const BOTH_RESULT = parseCommandOutput("review.ask", {
  mode: "both",
  primary: {
    model: "Orchestrator · Claude",
    answer: "milliseconds — worth a rename, not a behaviour change",
  },
  secondOpinion: { model: "codex", answer: "milliseconds; the client divides by 1000 on read" },
}) as AskReviewResult;

describe("AskControl — the send control + routing caret", () => {
  it("defaults to the orchestrator and does not open the menu unprompted", () => {
    const { container } = mount(
      <AskControl
        mode="orchestrator"
        question=""
        onQuestionChange={vi.fn()}
        onModeChange={vi.fn()}
        onAsk={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-ask-mode="orchestrator"]')).toBeTruthy();
    // The kit Popover portals the menu to the document body; it is closed until prompted.
    expect(document.querySelector(".ask-menu")).toBeNull();
  });

  it("opens the caret menu with BOTH options and marks the current one checked", async () => {
    const { container, getByText, user } = mount(
      <AskControl
        mode="orchestrator"
        question=""
        onQuestionChange={vi.fn()}
        onModeChange={vi.fn()}
        onAsk={vi.fn()}
      />,
    );
    const caret = container.querySelector<HTMLButtonElement>(".ask-send-caret");
    if (!caret) throw new Error("expected the caret");
    await user.click(caret);
    expect(getByText("Ask the orchestrator")).toBeTruthy();
    expect(getByText("Ask both models")).toBeTruthy();
    const orchestrator = document.querySelector('[data-mode="orchestrator"]');
    expect(orchestrator?.getAttribute("aria-checked")).toBe("true");
  });

  it("advertises a menu popup and Escape light-dismisses it (kit Popover parity)", async () => {
    const { container, user } = mount(
      <AskControl
        mode="orchestrator"
        question=""
        onQuestionChange={vi.fn()}
        onModeChange={vi.fn()}
        onAsk={vi.fn()}
      />,
    );
    const caret = need<HTMLButtonElement>(container, ".ask-send-caret");
    // The trigger advertises a MENU (not a dialog) around the menuitemradio rows.
    expect(caret.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(caret);
    expect(document.querySelector(".ask-menu")).toBeTruthy();
    // Escape dismisses (an affordance the bare toggle lacked; the kit provides it).
    await user.keyboard("{Escape}");
    expect(document.querySelector(".ask-menu")).toBeNull();
  });

  it("picking 'ask both models' is a mode change and closes the menu", async () => {
    const onModeChange = vi.fn();
    const { container, user } = mount(
      <AskControl
        mode="orchestrator"
        question=""
        onQuestionChange={vi.fn()}
        onModeChange={onModeChange}
        onAsk={vi.fn()}
      />,
    );
    await user.click(need<HTMLButtonElement>(container, ".ask-send-caret"));
    await user.click(need<HTMLButtonElement>(document, '[data-mode="both"]'));
    expect(onModeChange).toHaveBeenCalledWith("both");
    expect(document.querySelector(".ask-menu")).toBeNull();
  });

  it("sends the question under the current mode when Ask is pressed", async () => {
    const onAsk = vi.fn();
    const { container, user } = mount(
      <AskControl
        mode="both"
        question="does the client agree?"
        onQuestionChange={vi.fn()}
        onModeChange={vi.fn()}
        onAsk={onAsk}
      />,
    );
    const ask = container.querySelector<HTMLButtonElement>(".ask-send-primary");
    if (!ask) throw new Error("expected the Ask button");
    expect(ask.getAttribute("data-ask-mode")).toBe("both");
    await user.click(ask);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("disables Ask for a blank question and while an ask is pending", () => {
    const blank = mount(
      <AskControl
        mode="orchestrator"
        question="   "
        onQuestionChange={vi.fn()}
        onModeChange={vi.fn()}
        onAsk={vi.fn()}
      />,
    );
    expect(blank.container.querySelector<HTMLButtonElement>(".ask-send-primary")?.disabled).toBe(
      true,
    );
    const pending = mount(
      <AskControl
        mode="orchestrator"
        question="a real question"
        pending
        onQuestionChange={vi.fn()}
        onModeChange={vi.fn()}
        onAsk={vi.fn()}
      />,
    );
    expect(pending.container.querySelector<HTMLButtonElement>(".ask-send-primary")?.disabled).toBe(
      true,
    );
  });
});

// A tiny stateful host mirroring the parent's per-thread memory, so the "remembered
// per thread, never global" rule is exercised through the REAL surface.
function ThreadHost({ threadId }: { threadId: string }) {
  const [byThread, setByThread] = useState<AskModeByThread>({});
  return (
    <AskControl
      mode={askModeForThread(byThread, threadId)}
      question=""
      onQuestionChange={vi.fn()}
      onModeChange={(mode) => setByThread((prev) => rememberAskMode(prev, threadId, mode))}
      onAsk={vi.fn()}
    />
  );
}

describe("AskControl — per-thread memory (not global)", () => {
  it("remembers 'ask both' for its thread but a new thread starts at the default", async () => {
    const { container, rerender, user } = mount(<ThreadHost threadId="thread-a" />);
    // Choose "ask both" in thread A.
    await user.click(need<HTMLButtonElement>(container, ".ask-send-caret"));
    await user.click(need<HTMLButtonElement>(document, '[data-mode="both"]'));
    expect(container.querySelector('[data-ask-mode="both"]')).toBeTruthy();
    // Switch to a NEW thread: it is back at the orchestrator-only default (not sticky).
    rerender(<ThreadHost threadId="thread-b" />);
    expect(container.querySelector('[data-ask-mode="orchestrator"]')).toBeTruthy();
    expect(container.querySelector('[data-ask-mode="both"]')).toBeNull();
  });
});

describe("AskAnswers — labelled answers, no synthesis", () => {
  it("renders ONE labelled card for an orchestrator-only result, no synthesis footer", () => {
    const { container, getByText } = mount(
      <AskAnswers question="is it seconds or ms?" result={ORCHESTRATOR_RESULT} />,
    );
    const cards = container.querySelectorAll(".ask-answer-card");
    expect(cards).toHaveLength(1);
    expect(getByText("Orchestrator · Claude")).toBeTruthy();
    expect(getByText("You asked:")).toBeTruthy();
    expect(container.querySelector(".ask-answers-foot")).toBeNull();
  });

  it("renders TWO labelled cards side by side for a both result, orchestrator then codex", () => {
    const { container, getByText } = mount(
      <AskAnswers question="does the client agree?" result={BOTH_RESULT} />,
    );
    const models = [...container.querySelectorAll(".ask-answer-head")].map((el) => el.textContent);
    expect(models).toEqual(["Orchestrator · Claude", "codex"]);
    expect(getByText("You asked both:")).toBeTruthy();
    // Each model's answer is shown verbatim, side by side.
    expect(getByText(/worth a rename/)).toBeTruthy();
    expect(getByText(/divides by 1000/)).toBeTruthy();
  });

  it("shows the 'no synthesis block' footer and NEVER a third merged card", () => {
    const { container, getByText } = mount(<AskAnswers question="q" result={BOTH_RESULT} />);
    expect(getByText(/no synthesis block/)).toBeTruthy();
    // Exactly two cards — there is no element a synthesized answer could occupy.
    expect(container.querySelectorAll(".ask-answer-card")).toHaveLength(2);
  });
});
