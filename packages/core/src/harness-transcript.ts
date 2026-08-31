// ─────────────────────────────────────────────────────────────────────────────
// The harness-transcript projector (issue-set B). A pure fold from the harness
// events the adapter ALREADY normalizes (tool.started / tool.output / tool.denied /
// text.* / thinking.*) onto the protocol `SessionTranscriptRow` shape the chat dock
// renders.
//
// This is a DISPLAY read-model, ADDITIVE to B9's cursor-canonical design — it does
// NOT reverse it. The harness CLI stays the canonical owner of the conversation and
// resume still rides the `HarnessCursor` (#466 res. 3); these rows exist only so the
// dock can show history and survive a reload. The events flowing in are the same ones
// the turn loop already consumes — B captures and projects them, it adds no new SDK
// subscription.
//
// Client-safe: pure, no Node imports. It scrubs NOTHING: the rows carry the harness's
// own text, host paths included, because they are persisted on the reviewer's own machine
// for the reviewer to read. R19 ("no host path to a REMOTE client") is a transport rule and
// the server applies it at the wire, in `projectCommandOutput`, for a projected connection
// only — see `packages/server/src/projection.ts`.
//
// Taxonomy (tool-lifecycle kinds, the reasoning-vs-prose lane split) is informed by
// t3code (T3 Tools Inc., MIT) as a reference; no t3 code is used here — Rennet's own
// event model and this fold cover the ground — so no attribution notice is owed.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ActivityStep,
  ContentBlock,
  SessionTranscriptRow,
  TranscriptBlock,
} from "@rennet/protocol";
import type { HarnessEvent, ToolCall } from "./harness";

type TurnStatus = "streaming" | "complete" | "interrupted";
type ThoughtBlock = Extract<TranscriptBlock, { kind: "thought" }>;
type ActionBlock = Extract<TranscriptBlock, { kind: "action" }>;

export interface HarnessTranscriptProjectorOptions {
  /** Public transcript id to use instead of the harness's turn id. */
  readonly turnId?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A tool call's display label + its primary argument (`Read.file_path`, `Bash.command`,
 *  `Glob.path`, …) — verbatim, so the reviewer reads the argument the harness actually used. */
function describeTool(call: ToolCall): { label: string; detail?: string } {
  const input = call.input;
  const primary =
    asString(input.file_path) ??
    asString(input.path) ??
    asString(input.notebook_path) ??
    asString(input.command) ??
    asString(input.pattern) ??
    asString(input.url);
  return primary ? { label: call.name, detail: primary } : { label: call.name };
}

function splitParagraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trimEnd())
    .filter((p) => p.length > 0);
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

function isoTime(receivedAt: number | undefined): string | undefined {
  if (receivedAt === undefined || !Number.isFinite(receivedAt)) return undefined;
  const date = new Date(receivedAt);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function thoughtLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function fenceInfo(info: string): { path: string; lang?: string } {
  const pathMatch = /\bpath=(?:"([^"]*)"|'([^']*)'|([^\s]+))/u.exec(info);
  const explicitPath = pathMatch?.[1] ?? pathMatch?.[2] ?? pathMatch?.[3];
  const remainder = pathMatch ? info.replace(pathMatch[0], "").trim() : info.trim();
  const tokens = remainder.split(/\s+/u).filter((token) => token.length > 0);
  const lang = tokens[0];
  const path = explicitPath ?? tokens[1] ?? "";
  return { path, ...(lang === undefined ? {} : { lang }) };
}

function contentBlocks(text: string): ContentBlock[] {
  const lines = text.split("\n");
  const blocks: ContentBlock[] = [];
  let textStart = 0;
  let foundFence = false;
  let lineIndex = 0;

  const pushText = (start: number, end: number) => {
    const prose = lines.slice(start, end).join("\n").trim();
    if (prose !== "") blocks.push({ kind: "text", text: prose });
  };

  while (lineIndex < lines.length) {
    const opening = /^ {0,3}(`{3,})([^\n]*)$/u.exec(lines[lineIndex] ?? "");
    if (!opening) {
      lineIndex += 1;
      continue;
    }

    const fence = opening[1];
    if (fence === undefined) {
      lineIndex += 1;
      continue;
    }
    const closing = new RegExp(`^ {0,3}${fence}[ \\t]*$`, "u");
    let closingIndex = lineIndex + 1;
    while (closingIndex < lines.length && !closing.test(lines[closingIndex] ?? "")) {
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) {
      lineIndex += 1;
      continue;
    }

    foundFence = true;
    pushText(textStart, lineIndex);
    blocks.push({
      kind: "code",
      ...fenceInfo(opening[2] ?? ""),
      code: lines.slice(lineIndex + 1, closingIndex).join("\n"),
    });
    lineIndex = closingIndex + 1;
    textStart = lineIndex;
  }

  if (!foundFence) return text.trim() === "" ? [] : [{ kind: "text", text }];
  pushText(textStart, lines.length);
  return blocks;
}

function isActivityStep(block: TranscriptBlock): block is ActivityStep {
  return block.kind === "thought" || block.kind === "action";
}

function isContentBlock(block: TranscriptBlock): block is ContentBlock {
  return block.kind === "text" || block.kind === "code";
}

/** A row already settled by a flush, plus the recipe for its id.
 *
 * Ids embed the turn id, and the turn id can be named by an event that arrives AFTER the row
 * was settled (a compaction before the harness reported its turn id). Keeping the recipe and
 * applying it at read is what makes an incremental fold agree with a from-scratch one. */
interface EmittedRow {
  /** Carries `id: ""` — the real id is applied by `rows()`, which knows the resolved base. */
  readonly row: SessionTranscriptRow;
  readonly idFor: (baseTurnId: string) => string;
}

/**
 * The incremental face of the projector: push one event at a time, read the rows at any point.
 *
 * `rows()` is NON-DESTRUCTIVE — it projects the current state without settling it — so a live
 * turn can snapshot after every event and still end up with exactly the rows a from-scratch
 * fold over the same events produces. That equivalence is the load-bearing property, and
 * `harness-transcript-fold.test.ts` pins it snapshot-by-snapshot.
 *
 * ponytail: a snapshot's `thought`/`action` blocks are the SAME objects the fold keeps
 * mutating (a later `tool.output` completes an action already handed out). Every caller today
 * either serializes the snapshot immediately (the live WS frame) or takes it after the turn's
 * terminal event (persistence), so nothing observes the mutation. Copy blocks on snapshot if a
 * caller ever retains a mid-turn one.
 */
export interface HarnessTranscriptFold {
  /** Fold one event in, in arrival order. */
  push(event: HarnessEvent): void;
  /** The rows for every event pushed so far, including the still-open turn. */
  rows(): SessionTranscriptRow[];
}

/**
 * Project one turn's harness events in arrival order, incrementally. New rows carry one ordered
 * `blocks` stream plus the legacy `preface` and `body` projections. A compaction flushes the
 * current segment before its boundary row. Content is carried verbatim; the wire projection
 * scrubs it.
 */
export function createHarnessTranscriptFold(
  options: HarnessTranscriptProjectorOptions = {},
): HarnessTranscriptFold {
  const fixedTurnId =
    options.turnId !== undefined && options.turnId !== "" ? options.turnId : undefined;
  let harnessTurnId: string | undefined;
  let firstSeq: number | undefined;
  const baseTurnIdOf = (): string => fixedTurnId ?? harnessTurnId ?? `turn-${firstSeq ?? 0}`;

  const emitted: EmittedRow[] = [];
  // `pending` holds ALREADY-EXPANDED blocks; the one text block that can still grow lives in
  // `openText` and is expanded when it closes. That is what makes the fold incremental — a
  // settled text block is fence-parsed once, not once per snapshot.
  let pending: TranscriptBlock[] = [];
  let finalText: string | undefined;
  let firstReceivedAt: number | undefined;
  let status: TurnStatus = "streaming";
  let turnSegment = 0;

  const actionByCall = new Map<string, ActionBlock>();
  let openThought: { block: ThoughtBlock; startedAt: number; text: string } | null = null;
  let openText: { text: string } | null = null;

  const closeThought = (receivedAt: number, settledStatus: TurnStatus = "complete") => {
    if (openThought === null) return;
    const elapsedMs = receivedAt - openThought.startedAt;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) openThought.block.seconds = elapsedMs / 1_000;
    openThought.block.status = settledStatus;
    openThought = null;
  };

  // Only the LAST entry can still grow: every arm that appends closes the open text block
  // first, so expanding at close time preserves arrival order exactly.
  const closeText = () => {
    if (openText === null) return;
    pending.push(...contentBlocks(openText.text));
    openText = null;
  };

  const markReceivedAt = (receivedAt: number) => {
    if (firstReceivedAt === undefined) firstReceivedAt = receivedAt;
  };

  const interruptOpenActions = () => {
    for (const block of pending) {
      if (block.kind === "action" && block.status === "streaming") block.status = "interrupted";
    }
  };

  /** The current turn's row, WITHOUT settling it — safe to call on every snapshot. */
  const buildTurnRow = (settledStatus: TurnStatus): EmittedRow | null => {
    const blocks: TranscriptBlock[] =
      openText === null ? [...pending] : [...pending, ...contentBlocks(openText.text)];
    const hasContent = blocks.some(isContentBlock);
    if (!hasContent && finalText !== undefined && finalText.trim() !== "") {
      blocks.push(...contentBlocks(finalText));
    }
    if (blocks.length === 0) return null;

    const preface = blocks.filter(isActivityStep);
    const body = blocks.filter(isContentBlock);
    const paragraphs = body
      .filter((block): block is Extract<ContentBlock, { kind: "text" }> => block.kind === "text")
      .flatMap((block) => splitParagraphs(block.text));
    const time = isoTime(firstReceivedAt);
    const segment = turnSegment;
    return {
      row: {
        kind: "turn",
        id: "",
        speaker: "orchestrator",
        status: settledStatus,
        paragraphs,
        ...(time === undefined ? {} : { time }),
        ...(preface.length ? { preface } : {}),
        ...(body.length ? { body } : {}),
        blocks,
      },
      idFor: (base) => (segment === 0 ? base : `${base}:segment:${segment}`),
    };
  };

  const flushTurn = (settledStatus: TurnStatus = status) => {
    const built = buildTurnRow(settledStatus);
    if (built === null) return;
    emitted.push(built);
    turnSegment += 1;
    pending = [];
    finalText = undefined;
    firstReceivedAt = undefined;
    status = "streaming";
    actionByCall.clear();
    openThought = null;
    openText = null;
  };

  const push = (event: HarnessEvent): void => {
    if (firstSeq === undefined) firstSeq = event.seq;
    if (harnessTurnId === undefined && event.turnId !== null && event.turnId !== "") {
      harnessTurnId = event.turnId;
    }
    switch (event.kind) {
      case "thinking.delta": {
        closeText();
        if (openThought === null) {
          markReceivedAt(event.receivedAt);
          const block: ThoughtBlock = {
            kind: "thought",
            id: `thought-${event.seq}`,
            status: "streaming",
            text: [],
          };
          pending.push(block);
          openThought = { block, startedAt: event.receivedAt, text: "" };
        }
        openThought.text += event.text;
        openThought.block.text = thoughtLines(openThought.text);
        break;
      }
      case "thinking.message": {
        closeText();
        if (openThought !== null) {
          if (event.text.trim() !== "") {
            openThought.text = event.text;
            openThought.block.text = thoughtLines(event.text);
          }
          closeThought(event.receivedAt);
        } else if (event.text.trim() !== "") {
          markReceivedAt(event.receivedAt);
          pending.push({
            kind: "thought",
            id: `thought-${event.seq}`,
            status: "complete",
            text: thoughtLines(event.text),
          });
        }
        break;
      }
      case "text.message": {
        closeThought(event.receivedAt);
        if (event.text.trim() !== "") {
          markReceivedAt(event.receivedAt);
          if (openText === null) {
            pending.push(...contentBlocks(event.text));
          } else {
            openText.text = event.text;
          }
        }
        closeText();
        break;
      }
      case "text.delta": {
        closeThought(event.receivedAt);
        if (openText === null) {
          markReceivedAt(event.receivedAt);
          openText = { text: "" };
        }
        openText.text += event.text;
        break;
      }
      case "tool.started": {
        closeThought(event.receivedAt);
        closeText();
        markReceivedAt(event.receivedAt);
        const { label, detail } = describeTool(event.call);
        const block: ActionBlock = {
          kind: "action",
          id: `act-${event.call.id}`,
          label,
          ...(detail ? { detail } : {}),
          status: "streaming",
          toolKind: event.call.kind,
        };
        actionByCall.set(event.call.id, block);
        pending.push(block);
        break;
      }
      case "tool.output": {
        closeThought(event.receivedAt);
        closeText();
        const step = actionByCall.get(event.callId);
        if (step) {
          step.status = "complete";
          const summary = firstLine(event.text);
          if (summary) step.doneDetail = summary;
          if (!event.ok) step.doneLabel = `${step.label} (failed)`;
        }
        break;
      }
      case "tool.denied": {
        closeThought(event.receivedAt);
        closeText();
        const step = event.callId === null ? undefined : actionByCall.get(event.callId);
        if (step) {
          step.status = "complete";
          step.denied = true;
          step.doneLabel = `Denied: ${event.reason}`;
        } else {
          markReceivedAt(event.receivedAt);
          pending.push({
            kind: "action",
            id: `act-denied-${event.seq}`,
            label: `Denied ${event.toolName}`,
            detail: event.reason,
            status: "complete",
            toolKind: "other",
            denied: true,
          });
        }
        break;
      }
      case "compact_boundary": {
        closeThought(event.receivedAt);
        closeText();
        flushTurn("complete");
        const time = isoTime(event.receivedAt);
        emitted.push({
          row: {
            kind: "compact-boundary",
            id: "",
            ...(time === undefined ? {} : { time }),
            ...(event.preTokens === undefined ? {} : { tokensBefore: event.preTokens }),
            ...(event.postTokens === undefined ? {} : { tokensAfter: event.postTokens }),
          },
          idFor: (base) => `compact-${base}-${event.seq}`,
        });
        break;
      }
      case "session.ended": {
        status = event.outcome.status === "completed" ? "complete" : "interrupted";
        closeThought(event.receivedAt, status);
        closeText();
        if (status === "interrupted") interruptOpenActions();
        if (event.outcome.status === "completed") {
          finalText = event.outcome.finalText;
          if (finalText.trim() !== "") markReceivedAt(event.receivedAt);
        }
        break;
      }
      // session.started / auth / error / passthrough carry no transcript row content.
      default:
        break;
    }
  };

  const rows = (): SessionTranscriptRow[] => {
    const base = baseTurnIdOf();
    const out = emitted.map((entry) => ({ ...entry.row, id: entry.idFor(base) }));
    const trailing = buildTurnRow(status);
    if (trailing !== null) out.push({ ...trailing.row, id: trailing.idFor(base) });
    return out;
  };

  return { push, rows };
}

/**
 * Project a whole turn's events at once. The array form of {@link createHarnessTranscriptFold}
 * — same fold, one shot — so a batch projection and a live incremental one cannot drift apart.
 */
export function harnessEventsToRows(
  events: readonly HarnessEvent[],
  options: HarnessTranscriptProjectorOptions = {},
): SessionTranscriptRow[] {
  const fold = createHarnessTranscriptFold(options);
  for (const event of events) fold.push(event);
  return fold.rows();
}
