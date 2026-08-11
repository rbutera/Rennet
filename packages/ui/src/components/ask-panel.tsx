import type { RennetBridge } from "@rennet/protocol";
import { useState } from "react";
import { type AskMode, type AskReviewResult, DEFAULT_ASK_MODE } from "../canvas/ask";
import { AskAnswers, AskControl } from "./ask";

// The Ask panel (issue #139, bead workspace-alqow): the reviewer's live way to ask
// the AI a question ABOUT the open review. This is the affordance that finally
// FIRES the wired path — `review.ask` over the real `askReview` router, whose
// orchestrator port drives the live `claude` turn over the canvasOps@2 context
// surface, and whose Codex port ("both" only) shells one `codex exec`.
//
// The load-bearing invariant (Rai, #139) is carried by the shapes it composes, not
// re-implemented here: `AskAnswers` renders at most two labelled cards and has no
// "merged answer" element, and the wire result (`AskReviewResult`) has no third
// field. This panel cannot manufacture a synthesis.
//
// Scope (v1): the answer arrives non-streamed (the orchestrator turn resolves to
// its final text, then the cards render). Live token-STREAMING into the panel and a
// multi-turn conversation thread are the deferred follow-ups; a working single-shot
// ask lands first.

export interface AskPanelProps {
  /** The command bridge — `review.ask` runs over it. */
  bridge: RennetBridge;
  /** The open review a question is ABOUT. */
  reviewId: string;
}

/**
 * A self-contained ask surface: a question box + the one-model/both split, and the
 * side-by-side answer cards for the last question. Holds only its own draft/mode/
 * result state, so mounting it next to the canvases needs nothing from the parent
 * but the bridge and the review id.
 */
export function AskPanel({ bridge, reviewId }: AskPanelProps) {
  // The routing for the next question. Defaults to "orchestrator" so pressing Ask
  // without touching the caret NEVER fires a second model (the same wrong-side-safe
  // default the schema and router enforce).
  const [mode, setMode] = useState<AskMode>(DEFAULT_ASK_MODE);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // The last answered question + its routed result. Undefined until the first ask
  // resolves, so the panel shows only the control until there is a real answer.
  const [asked, setAsked] = useState<{ question: string; result: AskReviewResult } | undefined>(
    undefined,
  );

  async function ask(): Promise<void> {
    const trimmed = question.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await bridge.invoke("review.ask", {
        commandId: crypto.randomUUID(),
        reviewId,
        mode,
        question: trimmed,
      });
      setAsked({ question: trimmed, result });
      setQuestion("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="ask-panel" aria-label="Ask the AI about this review">
      <header className="ask-panel-head">
        <p className="eyebrow">ASK THE AI</p>
        <p className="ask-panel-hint">
          Ask about this review. One model, or both — side by side, never merged.
        </p>
      </header>
      {asked ? <AskAnswers question={asked.question} result={asked.result} /> : null}
      {error ? (
        <p className="ask-panel-error" role="alert">
          {error}
        </p>
      ) : null}
      <AskControl
        mode={mode}
        question={question}
        pending={pending}
        onQuestionChange={setQuestion}
        onModeChange={setMode}
        onAsk={() => void ask()}
      />
    </section>
  );
}
