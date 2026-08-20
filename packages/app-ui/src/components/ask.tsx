import { Popover, PopoverContent, PopoverTrigger } from "@rennet/ui";
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

  const primaryClasses =
    "ask-send-primary inline-flex cursor-pointer items-center gap-1.5 rounded-l-control border border-r-0 border-accent-line bg-accent-fill px-3.5 py-2 font-sans text-base font-semibold text-accent-ink disabled:cursor-default disabled:opacity-50";
  // The routing menu rides the kit Popover: it owns the anchored positioning, the
  // portal, and the outside-click / Escape dismissal the bare toggle lacked. The
  // menu markup itself (role=menu + menuitemradio rows) is unchanged.
  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <div className="ask-send relative inline-flex items-stretch self-end">
        <button
          type="button"
          className={primaryClassName ? `${primaryClasses} ${primaryClassName}` : primaryClasses}
          data-ask-mode={mode}
          disabled={disabled}
          onClick={onAsk}
        >
          Ask
        </button>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="ask-send-caret inline-flex min-w-[30px] cursor-pointer items-center justify-center rounded-r-control border border-accent-line bg-accent-fill text-base text-accent-ink disabled:cursor-default disabled:opacity-50"
              aria-label="ask options"
              aria-haspopup="menu"
              disabled={pending}
            />
          }
        >
          <span aria-hidden="true">⌄</span>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          className="ask-menu-pop w-auto border-0 bg-transparent p-0 shadow-none ring-0"
        >
          <div
            className="ask-menu flex min-w-[260px] flex-col gap-0.5 rounded-control border border-line bg-overlay p-1.5 shadow-overlay"
            role="menu"
          >
            {ASK_OPTIONS.map((option) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={option.mode === mode}
                className="ask-menu-item flex cursor-pointer items-baseline justify-between gap-3.5 rounded-chip border-0 bg-transparent px-2.5 py-2 text-left font-sans text-base font-medium text-ink hover:bg-raised aria-checked:bg-raised"
                data-mode={option.mode}
                key={option.mode}
                onClick={() => pick(option.mode)}
              >
                <span className="ask-menu-label">{option.label}</span>
                <span className="ask-menu-hint text-2xs text-ink-faint">{option.hint}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </div>
    </Popover>
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
    <div
      className="ask-control flex flex-col gap-2.5 rounded-surface border border-line bg-surface p-3"
      data-ask-mode={mode}
    >
      <textarea
        className="ask-input min-h-[44px] w-full resize-y rounded-control border border-line bg-raised px-3 py-2.5 font-sans text-base text-ink placeholder:text-ink-faint disabled:opacity-60"
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
  /** Whether to echo the question above the cards. Defaults to true. */
  showQuestion?: boolean;
}

/**
 * The answers: the orchestrator's `primary` always, plus Codex's `secondOpinion`
 * when both were asked — rendered as labelled cards side by side. There is NO
 * synthesis card; the footer says so plainly, and the shape makes it impossible to
 * add one. If the two disagree, that disagreement is just something the reviewer
 * can ask the orchestrator about next.
 */
export function AskAnswers({ question, result, showQuestion = true }: AskAnswersProps) {
  const cards = askCards(result);
  const both = askedBoth(result);
  return (
    <div
      className="ask-answers group mt-3.5 flex flex-col gap-2.5"
      data-mode={result.mode}
      data-count={cards.length}
    >
      {showQuestion ? (
        <p className="ask-question-echo text-base leading-relaxed text-ink-soft">
          <span className="ask-question-label font-bold text-ink">
            {both ? "You asked both:" : "You asked:"}
          </span>{" "}
          <span className="ask-question-text">{question}</span>
        </p>
      ) : null}
      <div className="ask-answer-cards grid grid-cols-1 gap-3 group-data-[count=2]:grid-cols-2">
        {cards.map((card) => (
          // The model label is the stable, unique key: the orchestrator and Codex
          // cards always carry distinct labels, and there are at most two.
          <section
            className="ask-answer-card flex flex-col gap-2 rounded-control border border-line bg-raised px-3.5 py-3"
            data-model={card.model}
            key={card.model}
          >
            <header className="ask-answer-head font-sans text-2xs font-bold tracking-wide text-ink-soft">
              {card.model}
            </header>
            <p className="ask-answer-body font-serif text-base leading-relaxed text-ink">
              {card.answer}
            </p>
          </section>
        ))}
      </div>
      {both ? (
        <p className="ask-answers-foot text-center text-sm text-ink-faint">
          no synthesis block · two answers, side by side · you decide
        </p>
      ) : null}
    </div>
  );
}
