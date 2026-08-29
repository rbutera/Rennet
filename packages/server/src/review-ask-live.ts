import {
  type AskAnswer,
  type CodexExecutor,
  DEFAULT_CODEX_UTILITY_EFFORT,
  DEFAULT_CODEX_UTILITY_MODEL,
  type HandoffRunPort,
  type HarnessEvent,
  type HarnessInProcessTool,
} from "@rennet/core";
import type { Patchset, Review } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// review.ask — the LIVE ports (issue #139, bead workspace-alqow).
//
// `packages/core`'s `askReview` router owns the whole routing law (orchestrator
// once, "both" adds Codex, NEVER a synthesis) and is unit-proven. What was
// deferred was the LIVE invocation behind the two ports: `reviewAskFixturePorts()`
// returned canned answers. This module replaces that fixture with the real thing —
//
//   • `askOrchestrator` drives ONE live `claude` turn through `claudeHandoffRunPort`
//     — the same `HarnessPort.createSession` → `send` → drain → `close` port the
//     write handoff runs — at the review's repository root, streaming its text
//     deltas and returning its final text. The turn is capable by default (Bash
//     included), so the orchestrator can actually read the repository it is being
//     asked about; "do not commit or push" is a prompt instruction, matching the
//     handoff precedent, not a withheld capability.
//   • `askCodex` shells one `codex exec` (the same executor the pipeline's Codex
//     seat uses) over the review's diff + the question, returning a plain answer.
//
// Neither port touches the router's law: this module only supplies the two ports
// the router already calls, so "no synthesis, ever" stays exactly where it was
// proven. Both ports fail HONESTLY (a typed unavailable/failed answer, never a
// crash and never a fabricated success), mirroring the pipeline's degradation.
//
// Electron-free by construction (it takes injected functions as values), so it is
// unit-testable with fakes — no Electron, no real `claude`, no real `codex`.
// ─────────────────────────────────────────────────────────────────────────────

/** The label on the orchestrator's card (matches the fixture + prototype frame 14). */
export const ORCHESTRATOR_ASK_LABEL = "Orchestrator · Claude";
/** The label on Codex's second-opinion card. */
export const CODEX_ASK_LABEL = "codex";

/** How much of the raw diff is inlined into the one-shot Codex prompt (bounded so a
 *  huge changeset cannot blow the prompt; Codex has no tools on this call, so the
 *  inlined diff is its whole context). */
export const CODEX_ASK_DIFF_CEILING = 40_000;

/** How much of the raw diff is inlined into the orchestrator's prompt. Tighter than
 *  Codex's ceiling on purpose: the orchestrator holds the repository's real tools and
 *  can read any hunk the excerpt clips, so the inline diff is orientation, not its
 *  only context. A declared constant, never a magic number. */
export const ORCHESTRATOR_ASK_DIFF_CEILING = 16_000;

/** The active patchset a review's diff is read from (the same finder the app uses). */
function activePatchsetOf(review: Review): Patchset {
  const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
  if (!patchset) throw new Error("The active patchset is missing");
  return patchset;
}

/** The deps the live ports are bound to (all injected so the module stays testable). */
export interface LiveReviewAskDeps {
  /**
   * The live Codex second-opinion port. ABSENT when `codex` is not installed, in
   * which case `askCodex` returns an honest "unavailable" answer rather than
   * crashing the "both" ask (the router awaits it, so a throw would sink the whole
   * question).
   */
  askCodex?(input: {
    review: Review;
    question: string;
    /** Cancels the codex exec (#251 criterion 4) — the same controller the
     *  orchestrator leg gets, so one abort on quit cancels BOTH. */
    abortController?: AbortController;
  }): Promise<AskAnswer>;
  /**
   * The live orchestrator port (`createLiveOrchestratorAsk`). ABSENT when the
   * composition root wired none, in which case `askOrchestrator` returns the same
   * honest no-harness line the live port would — never a fabricated answer, and
   * never a build-vocabulary sentence about a rebuild the reviewer cannot see.
   */
  askOrchestrator?(input: {
    review: Review;
    question: string;
    onDelta?: (text: string) => void;
    onEvent?: (event: HarnessEvent) => void;
    selection?: { anchor: string; excerpt?: string; target?: string; generation?: string };
    turnId?: string;
    abortController?: AbortController;
  }): Promise<AskAnswer>;
}

/**
 * The dispatch-dep-shaped ports. Both take the ALREADY-RESOLVED `review` — dispatch
 * resolves and freshness-pins the review+patchset ONCE and hands the SAME snapshot
 * to both legs, so the two legs of a "both" ask can never cross two patchsets.
 */
export interface LiveReviewAskPorts {
  askOrchestrator(input: {
    review: Review;
    question: string;
    /** Token-stream sink (#251): each orchestrator token as it arrives. */
    onDelta?: (text: string) => void;
    /** Ordered normalized activity for the live transcript. */
    onEvent?: (event: HarnessEvent) => void;
    selection?: { anchor: string; excerpt?: string; target?: string; generation?: string };
    /** Public identity shared by stream, persistence, and transcript capture. */
    turnId?: string;
    onFocus?: (anchor: string) => void;
    /** Cancels the turn (#251 criterion 4): threaded to the SDK's `abortController`
     *  so `before-quit` reaps the live claude turn. */
    abortController?: AbortController;
  }): Promise<AskAnswer>;
  askCodex(input: {
    review: Review;
    question: string;
    /** Cancels the codex exec (#251 criterion 4): threaded to execa's `cancelSignal`. */
    abortController?: AbortController;
  }): Promise<AskAnswer>;
}

/**
 * Build the LIVE review.ask ports. Drop-in for `reviewAskFixturePorts()`: the same
 * `{ review, question } → AskAnswer` shape the dispatch path calls through the real
 * `askReview` router. The negative guarantee — orchestrator-only never calls Codex —
 * lives in that router, not here.
 */
export function createLiveReviewAskPorts(deps: LiveReviewAskDeps): LiveReviewAskPorts {
  return {
    async askOrchestrator({
      review,
      question,
      onDelta,
      onEvent,
      selection,
      turnId,
      abortController,
    }) {
      if (!deps.askOrchestrator) {
        return { model: ORCHESTRATOR_ASK_LABEL, answer: NO_HARNESS_ANSWER };
      }
      // Include each optional only when present, so a non-streaming caller invokes
      // the port with exactly the shape it passed (the file's existing style).
      return deps.askOrchestrator({
        review,
        question,
        ...(onDelta ? { onDelta } : {}),
        ...(onEvent ? { onEvent } : {}),
        ...(selection ? { selection } : {}),
        ...(turnId ? { turnId } : {}),
        ...(abortController ? { abortController } : {}),
      });
    },
    async askCodex({ review, question, abortController }) {
      if (!deps.askCodex) {
        return {
          model: CODEX_ASK_LABEL,
          answer: "Codex is not installed, so no second opinion is available.",
        };
      }
      // Include the controller only when present, so a non-reaping caller invokes the
      // codex port with exactly `{ review, question }` (its back-compat shape).
      return deps.askCodex({
        review,
        question,
        ...(abortController ? { abortController } : {}),
      });
    },
  };
}

/** The tiny structured-output schema the Codex ask is constrained to — one string
 *  field. Constraining the emission to JSON keeps the exec on the well-trodden
 *  `-o <file>` + `JSON.parse` path (the executor rejects non-JSON), and maps
 *  cleanly onto the `AskAnswer` the router expects. */
export const CODEX_ASK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Your answer to the reviewer's question." },
  },
  required: ["answer"],
  additionalProperties: false,
} as const;

/** Truncate `text` to at most `maxBytes` UTF-8 bytes (never code units — a
 *  multi-byte diff must honour the BYTE bound the ceiling claims). The cut is walked
 *  back off any partial trailing multi-byte sequence to a real char boundary, so the
 *  result is valid UTF-8 AND never exceeds `maxBytes` (a naive decode would emit a
 *  3-byte U+FFFD for the partial tail and slip over the bound). */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // Continuation bytes are 10xxxxxx; walk `end` back until it lands on a lead/ASCII
  // byte, so `subarray(0, end)` contains only whole code points.
  let end = maxBytes;
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  const decoded = new TextDecoder("utf-8").decode(bytes.subarray(0, end));
  return { text: decoded, truncated: true };
}

/** Assemble the one-shot Codex prompt: a terse instruction, the (byte-bounded) diff
 *  of the review, and the reviewer's question. Codex has no MCP tools this call — it
 *  is a single exec — so the diff is inlined as its whole context. */
export function buildCodexAskPrompt(diff: string, question: string): string {
  const { text: clipped, truncated } = truncateToBytes(diff, CODEX_ASK_DIFF_CEILING);
  const bounded = truncated
    ? `${clipped}\n… (diff truncated at ${CODEX_ASK_DIFF_CEILING} bytes)`
    : clipped;
  return [
    "You are a second-opinion code reviewer answering ONE question about a code change.",
    "Answer only the question, concisely and concretely. Do not restate the diff.",
    "",
    "The change under review (unified diff):",
    "```diff",
    bounded,
    "```",
    "",
    `The reviewer's question: ${question}`,
  ].join("\n");
}

/** Deps for the live Codex ask (the executor + optional model/effort overrides). */
export interface LiveCodexAskDeps {
  /** The real `codex exec` executor (`createCodexExecutor()`); injectable for tests. */
  executor: CodexExecutor;
  /** Codex model; defaults to the pipeline's light-tier utility model. */
  readonly model?: string;
  /** Reasoning effort; defaults to the pipeline's light-tier effort. */
  readonly effort?: string;
}

/**
 * Build the live Codex second-opinion port. One `codex exec` over the review's diff
 * + the question, constrained to `{ answer }` JSON. A non-zero exit / no-output /
 * non-JSON is a throw INSIDE the executor; we catch it and return an honest
 * "unavailable" answer so a "both" ask degrades to one real answer rather than
 * sinking the whole question (the orchestrator's `primary` already exists).
 */
export function createLiveCodexAsk(
  deps: LiveCodexAskDeps,
): (input: {
  review: Review;
  question: string;
  abortController?: AbortController;
}) => Promise<AskAnswer> {
  return async ({ review, question, abortController }) => {
    const patchset = activePatchsetOf(review);
    const prompt = buildCodexAskPrompt(patchset.rawDiff, question);
    try {
      const result = await deps.executor({
        model: deps.model ?? DEFAULT_CODEX_UTILITY_MODEL,
        effort: deps.effort ?? DEFAULT_CODEX_UTILITY_EFFORT,
        prompt,
        outputSchema: CODEX_ASK_OUTPUT_SCHEMA,
        // #251 criterion 4: execa's `cancelSignal` — a quit-abort force-kills the
        // codex child (unlike the claude child, whose PID the SDK never exposes).
        ...(abortController ? { signal: abortController.signal } : {}),
      });
      const output = result.output as { answer?: unknown } | null;
      const answer = typeof output?.answer === "string" ? output.answer.trim() : "";
      return {
        model: CODEX_ASK_LABEL,
        answer: answer.length > 0 ? answer : "Codex returned no answer.",
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { model: CODEX_ASK_LABEL, answer: `Codex could not answer: ${detail}` };
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE orchestrator leg (F1, #570) — the structural sibling of
// `createLiveCodexAsk` above. ONE turn through `claudeHandoffRunPort` (Decision 1:
// there is exactly one orchestration path; never a second drain loop), at the
// review's repository root, with NO checkpoint bracket (Decision 2: the bracket
// exists to measure a WRITE turn's diff, and an ask measures nothing).
// ─────────────────────────────────────────────────────────────────────────────

/** The honest line when no coding harness is installed. Not a fabricated answer, and
 *  not build vocabulary: it names the missing binary so the reader can act on it. */
export const NO_HARNESS_ANSWER =
  "No coding harness (claude) is installed, so the orchestrator cannot answer.";

/**
 * Assemble the orchestrator's prompt: the reviewer's question, where the repository
 * is, which patchset is under review (branch + base/head oids, so "the change" is
 * unambiguous even though the working tree may have moved on), and the byte-bounded
 * raw diff for orientation. The turn is capable by default, so the instruction to
 * read the repository is a real instruction, not a hint at an absent tool.
 */
export function buildOrchestratorAskPrompt(
  review: Review,
  question: string,
  selection?: { anchor: string; excerpt?: string; target?: string; generation?: string },
  appContext?: { readonly askLogId: string; readonly toolNames: readonly string[] },
): string {
  const patchset = activePatchsetOf(review);
  const { text: clipped, truncated } = truncateToBytes(
    patchset.rawDiff,
    ORCHESTRATOR_ASK_DIFF_CEILING,
  );
  const bounded = truncated
    ? `${clipped}\n… (diff truncated at ${ORCHESTRATOR_ASK_DIFF_CEILING} bytes — read the repository for the rest)`
    : clipped;
  const { repository } = patchset;
  const lines = [
    "You are the orchestrator of a code review, answering ONE question from the reviewer.",
    "Answer the question concretely and concisely, grounded in this actual change.",
    "You have the repository's full tool surface — read files, grep, run git — whenever",
    "the inlined diff below is not enough. Do NOT commit and do NOT push: the reviewer",
    "owns every published artefact.",
    "",
    `Repository root: ${review.repositoryRoot}`,
    `Branch: ${repository.headRef ?? "(detached HEAD)"}`,
    `Base: ${repository.baseRef} (${repository.baseOid})`,
    `Head: ${repository.headOid}`,
    "",
    "The change under review (unified diff):",
    "```diff",
    bounded,
    "```",
  ];
  if (selection) {
    lines.push("", `The reviewer is looking at: ${selection.anchor}`);
    if (selection.target) lines.push(`Board element: ${selection.target}`);
    if (selection.generation) lines.push(`Board generation: ${selection.generation}`);
    if (selection.excerpt) lines.push("```", selection.excerpt, "```");
  }
  if (appContext) {
    lines.push(
      "",
      `Current Rennet review ask-log id: ${appContext.askLogId}`,
      `Available Rennet app tools: ${appContext.toolNames.join(", ")}`,
      `For app_ask_stage, pass ${appContext.askLogId} as sessionId so the staged ask appears in this review.`,
      "When the reviewer asks you to act in Rennet, call the matching app tool exactly once.",
      "Treat its returned receipt/result as the authority and narrate the completed result, not intent.",
    );
  }
  lines.push("", `The reviewer's question: ${question}`);
  return lines.join("\n");
}

/** Deps for the live orchestrator ask. `resolveRunPort` is injected so this module
 *  stays hermetically testable with fakes — no Electron, no real `claude`. */
export interface LiveOrchestratorAskDeps {
  /** The turn port for a repository root, or `null` when no harness is installed. */
  resolveRunPort(repoRoot: string, review?: Review): Promise<HandoffRunPort | null>;
  /** The registry-projected app tool surface, rebuilt for each turn. */
  toolsForReview?: (review: Review) => readonly HarnessInProcessTool[];
  /** Canonical ask-log identity named as `sessionId` by the `ask.*` command family. */
  askLogIdForReview?: (review: Review) => string;
}

/**
 * Build the live orchestrator port. It NEVER throws: the router awaits it, and a
 * throw would sink a "both" ask alongside Codex's real answer (the same contract
 * `createLiveCodexAsk`'s catch already honours). A failed turn returns the port's
 * REAL reason, never a summary and never a plausible-sounding stand-in.
 */
export function createLiveOrchestratorAsk(
  deps: LiveOrchestratorAskDeps,
): (input: {
  review: Review;
  question: string;
  onDelta?: (text: string) => void;
  onEvent?: (event: HarnessEvent) => void;
  selection?: { anchor: string; excerpt?: string; target?: string; generation?: string };
  turnId?: string;
  abortController?: AbortController;
}) => Promise<AskAnswer> {
  return async ({ review, question, onDelta, onEvent, selection, turnId, abortController }) => {
    try {
      const run = await deps.resolveRunPort(review.repositoryRoot, review);
      if (!run) return { model: ORCHESTRATOR_ASK_LABEL, answer: NO_HARNESS_ANSWER };
      const tools = deps.toolsForReview?.(review) ?? [];
      const askLogId = deps.askLogIdForReview?.(review);
      const outcome = await run({
        cwd: review.repositoryRoot,
        prompt: buildOrchestratorAskPrompt(
          review,
          question,
          selection,
          askLogId === undefined
            ? undefined
            : { askLogId, toolNames: tools.map((tool) => tool.name) },
        ),
        ...(onDelta ? { onDelta } : {}),
        ...(onEvent ? { onEvent } : {}),
        ...(tools.length === 0 ? {} : { inProcessTools: tools }),
        ...(turnId ? { transcriptTurnId: `${turnId}::orchestrator` } : {}),
        ...(abortController ? { signal: abortController.signal } : {}),
      });
      if (outcome.status === "failed") {
        return {
          model: ORCHESTRATOR_ASK_LABEL,
          answer: `The orchestrator could not answer: ${outcome.reason}`,
        };
      }
      const answer = outcome.finalText.trim();
      return {
        model: ORCHESTRATOR_ASK_LABEL,
        answer: answer.length > 0 ? answer : "The orchestrator returned no answer.",
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        model: ORCHESTRATOR_ASK_LABEL,
        answer: `The orchestrator could not answer: ${detail}`,
      };
    }
  };
}
