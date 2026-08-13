import { useState } from "react";
import type { AskMode, AskReviewResult } from "../canvas/ask";
import { ASK_OPTIONS, askCards, askedBoth } from "../canvas/ask";

// The Ask surface (issue #139): the reviewer asks a question ABOUT the review, and
// chooses whether ONE model or BOTH answer. The send control carries one small
// split — "ask both models" — a per-message opt-in remembered per thread by the
// parent (never globally sticky). When both are asked, the two answers arrive as
// two labelled cards SIDE BY SIDE and the reviewer decides for themselves.
//
// The load-bearing invariant (Rai, prototype frame 14): there is NO synthesis
// block, ever. This surface cannot render one — `askCards` yields at most two
// cards and there is no "merged answer" element — so the invariant is structural
// here, not merely a layout choice.

export interface AskControlProps {
  /** The routing for THIS thread (from the parent's per-thread memory). */
  mode: AskMode;
  /** The draft question text (controlled by the parent). */
  question: string;
  /** True while an ask is in flight — disables the control so it can't double-fire. */
  pending?: boolean;
  /** The reviewer edited the draft question. */
  onQuestionChange(question: string): void;
  /**
   * The reviewer picked a routing from the caret menu. The PARENT remembers this
   * per thread (`rememberAskMode`) — this control never holds mode itself, so it
   * cannot become globally sticky.
   */
  onModeChange(mode: AskMode): void;
  /** Send the current question under the current mode. */
  onAsk(): void;
}

export interface AskButtonProps {
  mode: AskMode;
  disabled: boolean;
  pending?: boolean;
  primaryClassName?: string;
  onModeChange(mode: AskMode): void;
  onAsk(): void;
}

export function AskButton({
  mode,
  disabled,
  pending = false,
  primaryClassName,
  onModeChange,
  onAsk,
}: AskButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  function pick(next: AskMode): void {
    onModeChange(next);
    setMenuOpen(false);
  }

  return (
    <div className="ask-send">
      <button
        type="button"
        className={primaryClassName ? `ask-send-primary ${primaryClassName}` : "ask-send-primary"}
        data-ask-mode={mode}
        disabled={disabled}
        onClick={onAsk}
      >
        Ask
      </button>
      <button
        type="button"
        className="ask-send-caret"
        aria-label="ask options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={pending}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span aria-hidden="true">⌄</span>
      </button>
      {menuOpen ? (
        <div className="ask-menu" role="menu">
          {ASK_OPTIONS.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.mode === mode}
              className="ask-menu-item"
              data-mode={option.mode}
              key={option.mode}
              onClick={() => pick(option.mode)}
            >
              <span className="ask-menu-label">{option.label}</span>
              <span className="ask-menu-hint">{option.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The send control: a question box plus a split "Ask" button whose caret opens the
 * routing menu. "Ask the orchestrator" is the default; "Ask both models" is the
 * per-message opt-in. Picking an option is a mode change (remembered per thread by
 * the parent); pressing Ask sends under whatever mode is current.
 */
export function AskControl({
  mode,
  question,
  pending = false,
  onQuestionChange,
  onModeChange,
  onAsk,
}: AskControlProps) {
  const canSend = question.trim().length > 0 && !pending;

  return (
    <div className="ask-control" data-ask-mode={mode}>
      <textarea
        className="ask-input"
        placeholder="Ask about this review"
        value={question}
        disabled={pending}
        onChange={(event) => onQuestionChange(event.target.value)}
      />
      <AskButton
        mode={mode}
        disabled={!canSend}
        pending={pending}
        onModeChange={onModeChange}
        onAsk={onAsk}
      />
    </div>
  );
}

export interface AskAnswersProps {
  /** The question that was asked, echoed above the answers. */
  question: string;
  /** The routed result: the orchestrator's answer, plus Codex's ONLY when both were asked. */
  result: AskReviewResult;
}

/**
 * The answers: the orchestrator's `primary` always, plus Codex's `secondOpinion`
 * when both were asked — rendered as labelled cards side by side. There is NO
 * synthesis card; the footer says so plainly, and the shape makes it impossible to
 * add one. If the two disagree, that disagreement is just something the reviewer
 * can ask the orchestrator about next.
 */
export function AskAnswers({ question, result }: AskAnswersProps) {
  const cards = askCards(result);
  const both = askedBoth(result);
  return (
    <div className="ask-answers" data-mode={result.mode} data-count={cards.length}>
      <p className="ask-question-echo">
        <span className="ask-question-label">{both ? "You asked both:" : "You asked:"}</span>{" "}
        <span className="ask-question-text">{question}</span>
      </p>
      <div className="ask-answer-cards">
        {cards.map((card) => (
          // The model label is the stable, unique key: the orchestrator and Codex
          // cards always carry distinct labels, and there are at most two.
          <section className="ask-answer-card" data-model={card.model} key={card.model}>
            <header className="ask-answer-head">{card.model}</header>
            <p className="ask-answer-body">{card.answer}</p>
          </section>
        ))}
      </div>
      {both ? (
        <p className="ask-answers-foot">
          no synthesis block · two answers, side by side · you decide
        </p>
      ) : null}
    </div>
  );
}
