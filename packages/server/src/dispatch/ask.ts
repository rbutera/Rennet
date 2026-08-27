import { receiptFor } from "@rennet/core";
import { type AskEventBody, parseCommandInput, parseCommandOutput } from "@rennet/protocol";
import type { CommandHandler, DispatchRuntime } from "./runtime";

/**
 * The durable-asks command surface (B11 cluster 2, Q15, #458 R29–R36) — the ONE
 * write path for every reviewer interaction on an open review. Each write command
 * APPENDS exactly one event to the session's ask log via the store and returns the
 * RECEIPT (the inverse event body), so a client's undo is just feeding the receipt
 * back through the matching command. No handler mutates a projection directly; the
 * projection is always `foldAsks(log)`, read fresh from the store.
 *
 * The uniform write flow (`applyWrite`): read the PRIOR projection (the receipt
 * needs it — `edit`'s inverse is `edit(prior body)`, a verdict set's is
 * `set(prior)`/`clear`), append the event, derive the receipt from body + prior,
 * then EMIT the new projection to live clients (R19 push — a second paired device
 * sees the change without polling; a reconnecting one reads it via `ask.read`).
 */

export function applyWrite(
  rt: DispatchRuntime,
  sessionId: string,
  body: AskEventBody,
): { receipt: AskEventBody } {
  const store = rt.deps.askLog;
  const prior = store.readProjection(sessionId);
  store.append(sessionId, body);
  const receipt = receiptFor(body, prior);
  rt.deps.broadcastAskProjection?.(sessionId, store.readProjection(sessionId));
  return { receipt };
}

export function askHandlers(rt: DispatchRuntime) {
  return {
    "ask.stage": async (rawInput) => {
      const name = "ask.stage" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, { kind: "stage", ask: input.ask }),
      );
    },
    "ask.unstage": async (rawInput) => {
      const name = "ask.unstage" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, { kind: "unstage", id: input.id }),
      );
    },
    "ask.edit": async (rawInput) => {
      const name = "ask.edit" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, { kind: "edit", id: input.id, body: input.body }),
      );
    },
    "ask.retire": async (rawInput) => {
      const name = "ask.retire" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, { kind: "retire", id: input.id, reason: input.reason }),
      );
    },
    "ask.restore": async (rawInput) => {
      const name = "ask.restore" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, { kind: "restore", id: input.id }),
      );
    },
    "ask.quoteOpen": async (rawInput) => {
      const name = "ask.quoteOpen" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, {
          kind: "quote-open",
          threadId: input.threadId,
          thread: input.thread,
        }),
      );
    },
    "ask.quoteReply": async (rawInput) => {
      const name = "ask.quoteReply" as const;
      const input = parseCommandInput(name, rawInput);
      // A reply is append-shaped at the command (author + text); the event records the
      // RESULTING message list, so the fold sets and the receipt restores the prior list.
      const prior = rt.deps.askLog.readProjection(input.sessionId);
      const messages = [
        ...(prior.quoteThreads[input.threadId]?.messages ?? []),
        { author: input.author, text: input.text },
      ];
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, {
          kind: "quote-reply",
          threadId: input.threadId,
          messages,
        }),
      );
    },
    "ask.quoteClose": async (rawInput) => {
      const name = "ask.quoteClose" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, { kind: "quote-close", threadId: input.threadId }),
      );
    },
    "ask.setVerdictOverride": async (rawInput) => {
      const name = "ask.setVerdictOverride" as const;
      const input = parseCommandInput(name, rawInput);
      // One command, nullable verdict: a value SETS, null CLEARS (the client's single toggle).
      const body: AskEventBody =
        input.verdict === null
          ? { kind: "verdict-override-clear" }
          : { kind: "verdict-override-set", verdict: input.verdict };
      return parseCommandOutput(name, applyWrite(rt, input.sessionId, body));
    },
    "ask.setLineComment": async (rawInput) => {
      const name = "ask.setLineComment" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, {
          kind: "line-comment-set",
          path: input.path,
          line: input.line,
          body: input.body,
        }),
      );
    },
    "ask.clearLineComment": async (rawInput) => {
      const name = "ask.clearLineComment" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(
        name,
        applyWrite(rt, input.sessionId, {
          kind: "line-comment-clear",
          path: input.path,
          line: input.line,
        }),
      );
    },
    // The projection read — the session-open / reconnect rehydrate. Nothing is
    // client-derived: the durable projection IS the review's living-draft state.
    "ask.read": async (rawInput) => {
      const name = "ask.read" as const;
      const input = parseCommandInput(name, rawInput);
      return parseCommandOutput(name, {
        projection: rt.deps.askLog.readProjection(input.sessionId),
      });
    },
  } satisfies Record<string, CommandHandler>;
}
