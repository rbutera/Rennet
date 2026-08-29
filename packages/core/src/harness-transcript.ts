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

import type { ActivityStep, ContentBlock, SessionTranscriptRow } from "@rennet/protocol";
import type { HarnessEvent, ToolCall } from "./harness";

type TurnStatus = "streaming" | "complete" | "interrupted";

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

/**
 * Project one turn's harness events (in arrival order) onto transcript rows. Normally one
 * orchestrator `turn` row — its thought/action `preface` and its prose/code `body` — plus a
 * `compact-boundary` row for each in-turn compaction (which flushes the turn-so-far first, so
 * order is preserved). Content is carried verbatim; the wire projection is what scrubs.
 */
export function harnessEventsToRows(events: readonly HarnessEvent[]): SessionTranscriptRow[] {
  const rows: SessionTranscriptRow[] = [];
  const anchor = events[0]?.seq ?? 0;

  let preface: ActivityStep[] = [];
  let body: ContentBlock[] = [];
  let deltaBuf = "";
  let finalText: string | undefined;
  let status: TurnStatus = "complete";
  let seq = 0;

  const actionByCall = new Map<string, number>();
  let openThought: { idx: number; buf: string } | null = null;

  const closeThought = () => {
    openThought = null;
  };

  const flushTurn = () => {
    if (preface.length === 0 && body.length === 0 && deltaBuf.trim() === "" && !finalText) return;
    // Prefer settled `text.message` prose; fall back to the streaming delta echo, then to the
    // outcome's finalText — so a turn that only streamed still shows its reply.
    if (body.length === 0) {
      const fallback = deltaBuf.trim() !== "" ? deltaBuf : (finalText ?? "");
      if (fallback.trim() !== "") body.push({ kind: "text", text: fallback });
    }
    const paragraphs = body
      .filter((b): b is Extract<ContentBlock, { kind: "text" }> => b.kind === "text")
      .flatMap((b) => splitParagraphs(b.text));
    rows.push({
      kind: "turn",
      id: `turn-${anchor}-${seq++}`,
      speaker: "orchestrator",
      status,
      paragraphs,
      ...(preface.length ? { preface } : {}),
      ...(body.length ? { body } : {}),
    });
    preface = [];
    body = [];
    deltaBuf = "";
    finalText = undefined;
    status = "complete";
    actionByCall.clear();
    openThought = null;
  };

  for (const event of events) {
    switch (event.kind) {
      case "thinking.message":
      case "thinking.delta": {
        const chunk = event.kind === "thinking.message" ? `${event.text}\n` : event.text;
        if (openThought === null) {
          const idx = preface.length;
          preface.push({
            kind: "thought",
            id: `thought-${anchor}-${idx}`,
            status: "complete",
            text: [],
          });
          openThought = { idx, buf: "" };
        }
        openThought.buf += chunk;
        const block = preface[openThought.idx];
        if (block && block.kind === "thought") {
          block.text = openThought.buf
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        }
        break;
      }
      case "text.message":
        closeThought();
        if (event.text.trim() !== "") body.push({ kind: "text", text: event.text });
        break;
      case "text.delta":
        closeThought();
        deltaBuf += event.text;
        break;
      case "tool.started": {
        closeThought();
        const { label, detail } = describeTool(event.call);
        actionByCall.set(event.call.id, preface.length);
        preface.push({
          kind: "action",
          id: `act-${event.call.id}`,
          label,
          ...(detail ? { detail } : {}),
          status: "streaming",
          toolKind: event.call.kind,
        });
        break;
      }
      case "tool.output": {
        closeThought();
        const idx = actionByCall.get(event.callId);
        const step = idx === undefined ? undefined : preface[idx];
        if (step && step.kind === "action") {
          step.status = "complete";
          const summary = firstLine(event.text);
          if (summary) step.doneDetail = summary;
          if (!event.ok) step.doneLabel = `${step.label} (failed)`;
        }
        break;
      }
      case "tool.denied": {
        closeThought();
        const idx = event.callId === null ? undefined : actionByCall.get(event.callId);
        const step = idx === undefined ? undefined : preface[idx];
        if (step && step.kind === "action") {
          step.status = "complete";
          step.denied = true;
          step.doneLabel = `Denied: ${event.reason}`;
        } else {
          preface.push({
            kind: "action",
            id: `act-denied-${anchor}-${preface.length}`,
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
        flushTurn();
        rows.push({
          kind: "compact-boundary",
          id: `compact-${anchor}-${seq++}`,
          ...(event.preTokens === undefined ? {} : { tokensBefore: event.preTokens }),
          ...(event.postTokens === undefined ? {} : { tokensAfter: event.postTokens }),
        });
        break;
      }
      case "session.ended":
        if (event.outcome.status === "cancelled") status = "interrupted";
        if (event.outcome.status === "completed") finalText = event.outcome.finalText;
        break;
      // session.started / auth / error / passthrough carry no transcript row content.
      default:
        break;
    }
  }

  flushTurn();
  return rows;
}
