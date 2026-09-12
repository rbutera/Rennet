import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The orchestrator conversation the marketing captures show in the chat pane (#470).
 *
 * The pane is the vendored T3 Code thread view, mounted natively and reading the daemon-owned
 * sidecar's own store. Nothing here touches the DOM and nothing stands in for the pane: the
 * turns are appended as the sidecar's OWN orchestration events (`thread.message-sent`,
 * `thread.turn-start-requested`, `thread.session-set`, `thread.activity-appended`), in the
 * order and with the payloads a real Claude turn leaves in `orchestration_events`, while the
 * sidecar is stopped. At its next boot the vendored server's projector replays every event
 * after its checkpoint (`bootstrapProjector` in `orchestration/Layers/ProjectionPipeline.ts`)
 * and the pane renders the thread exactly as it renders one a reviewer typed.
 *
 * The thread itself is the real one: `review.capture` bound it for the session, and its id is
 * read back from the daemon's `thread-bindings.json`, never invented.
 *
 * No model runs. The environment is the same model-free one the hermetic e2e specs use.
 */

export interface ConversationTool {
  readonly name: "Read" | "Grep";
  readonly input: Readonly<Record<string, string>>;
}

export interface ConversationTurn {
  readonly user: string;
  /** The tool calls the orchestrator made before answering, in order. */
  readonly tools: readonly ConversationTool[];
  readonly assistant: string;
}

/**
 * Three turns of a reviewer questioning `feat/rate-limiting`, grounded in the fixture files and
 * the seeded Flagged board. The orchestrator surfaces and suggests; the reviewer decides. It
 * never claims to have staged, dispatched, pushed or posted anything.
 */
export const MARKETING_CONVERSATION: readonly ConversationTurn[] = [
  {
    user: "Does the limiter charge before auth? If a bad token can burn another org's bucket I want to know now.",
    tools: [
      { name: "Read", input: { file_path: "src/server.ts" } },
      { name: "Read", input: { file_path: "src/rate-limit/middleware.ts" } },
    ],
    assistant:
      "No. `buildHandler` in `src/server.ts` composes `auth(limiter(routes))`, so `auth` answers 401 before the limiter sees the request, and `rateLimit` passes a request with no `org` straight through. The Flagged board lists this under *Checked and cleared*.\n\nWorth knowing: `orgFor` in `src/middleware/auth.ts` takes the token's first dot-separated segment, so the bucket key is whatever the token claims. That is auth's job, not the limiter's, and it is unchanged on this branch.",
  },
  {
    user: "Then why does the store wrapper fail open? Redis down means no limit at all.",
    tools: [
      { name: "Read", input: { file_path: "src/rate-limit/store.ts" } },
      { name: "Grep", input: { pattern: "onError", path: "src" } },
    ],
    assistant:
      "Because the spec asks for it. The OpenSpec change's third requirement says a store outage must not block requests, and `failOpen` in `src/rate-limit/store.ts` is that requirement made literal: a rejected `get` becomes `undefined`, and `take` treats `undefined` as a new organisation with a full burst.\n\nWhat the spec does not cover is visibility. The only trace is one `console.error` per request in `bucketStore` (`src/server.ts`), and `X-RateLimit-Remaining` keeps reporting a healthy number while nothing is being limited. That is the high finding on Flagged; Claude and Codex both raised it and disagree on how serious it is.",
  },
  {
    user: "Keep fail-open, it's the right call for us. What's the smallest change that closes the visibility gap and fixes the 429 body?",
    tools: [{ name: "Read", input: { file_path: "docs/api.md" } }],
    assistant:
      'Two edits in `src/rate-limit/middleware.ts`, no new dependency.\n\nFirst, have `failOpen` report a failed read through its `onError` callback into a counter, and omit `X-RateLimit-Limit` and `X-RateLimit-Remaining` on that request, so operators and clients can both see the degraded state.\n\nSecond, answer the 429 through `json(response, 429, { error: "rate limit exceeded" })`, which keeps the envelope `docs/api.md` promises on the first limited request.\n\nBoth findings on the Flagged board cite the exact lines. If you want them in the next round, stage them from there and the work order will carry the citations.',
  },
];

interface ThreadBindingRow {
  readonly kind?: string;
  readonly sessionId?: string;
  readonly threadId: string;
}

/** The daemon's own binding for the review's orchestrator thread, or a clear error. */
function boundThreadId(userData: string, reviewId: string): string {
  const path = join(userData, "t3", "thread-bindings.json");
  if (!existsSync(path)) throw new Error(`no thread bindings at ${path}`);
  const file = JSON.parse(readFileSync(path, "utf8")) as { bindings: ThreadBindingRow[] };
  const row = file.bindings.find(
    (binding) => (binding.kind ?? "session") === "session" && binding.sessionId === reviewId,
  );
  if (row === undefined) throw new Error(`review ${reviewId} has no bound T3 thread`);
  return row.threadId;
}

interface SeedEvent {
  readonly type: string;
  readonly actor: "client" | "provider" | "server";
  readonly commandId: string | null;
  readonly causationEventId?: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

/** Wire-shaped tool activity, mirroring what the Claude adapter emits for a completed call. */
function toolActivity(
  threadId: string,
  turnId: string,
  tool: ConversationTool,
  at: string,
): SeedEvent {
  const toolCallId = `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  return {
    type: "thread.activity-appended",
    actor: "provider",
    commandId: `provider:${crypto.randomUUID()}:item.completed`,
    occurredAt: at,
    payload: {
      threadId,
      activity: {
        id: crypto.randomUUID(),
        tone: "tool",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          toolCallId,
          status: "completed",
          detail: `${tool.name}: ${JSON.stringify(tool.input)}`,
          data: { toolName: tool.name, input: tool.input },
        },
        turnId,
        createdAt: at,
      },
    },
  };
}

/**
 * The events one turn leaves behind, in the order the sidecar writes them: the reviewer's
 * message and turn request (client), the session going running (server), each tool call and
 * the assistant's message (provider), the turn settling and the session going idle.
 */
function turnEvents(threadId: string, turn: ConversationTurn, startedAt: number): SeedEvent[] {
  const turnId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  let clock = startedAt;
  const tick = (ms: number): string => {
    clock += ms;
    return new Date(clock).toISOString();
  };
  const session = (status: "running" | "idle", activeTurnId: string | null, at: string) => ({
    threadId,
    session: {
      threadId,
      status,
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId,
      lastError: null,
      updatedAt: at,
    },
  });
  const sentAt = tick(0);
  const userMessage: SeedEvent = {
    type: "thread.message-sent",
    actor: "client",
    commandId,
    occurredAt: sentAt,
    payload: {
      threadId,
      messageId: userMessageId,
      role: "user",
      text: turn.user,
      turnId: null,
      streaming: false,
      createdAt: sentAt,
      updatedAt: sentAt,
    },
  };
  const events: SeedEvent[] = [
    userMessage,
    {
      type: "thread.turn-start-requested",
      actor: "client",
      commandId,
      occurredAt: sentAt,
      payload: {
        threadId,
        messageId: userMessageId,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: sentAt,
      },
    },
    {
      type: "thread.session-set",
      actor: "server",
      commandId: `server:${crypto.randomUUID()}`,
      occurredAt: tick(600),
      payload: session("running", turnId, new Date(clock).toISOString()),
    },
  ];
  for (const tool of turn.tools) events.push(toolActivity(threadId, turnId, tool, tick(1_800)));
  const answeredAt = tick(4_200);
  events.push({
    type: "thread.message-sent",
    actor: "provider",
    commandId: `provider:${crypto.randomUUID()}:assistant`,
    occurredAt: answeredAt,
    payload: {
      threadId,
      messageId: assistantMessageId,
      role: "assistant",
      text: turn.assistant,
      turnId,
      streaming: false,
      createdAt: answeredAt,
      updatedAt: answeredAt,
    },
  });
  const settledAt = tick(300);
  events.push(
    {
      type: "thread.activity-appended",
      actor: "provider",
      commandId: `provider:${crypto.randomUUID()}:turn.completed`,
      occurredAt: settledAt,
      payload: {
        threadId,
        activity: {
          id: crypto.randomUUID(),
          tone: "info",
          kind: "turn.settled",
          summary: "Turn settled",
          payload: { state: "completed", durationMs: clock - startedAt },
          turnId,
          createdAt: settledAt,
        },
      },
    },
    {
      type: "thread.session-set",
      actor: "server",
      commandId: `server:${crypto.randomUUID()}`,
      occurredAt: settledAt,
      payload: session("idle", null, settledAt),
    },
  );
  return events;
}

/**
 * Append the conversation to the review's bound thread in the sidecar's store. Call it with
 * the app closed (the daemon stops its sidecar when it exits) and relaunch afterwards: the
 * projector picks the events up at boot. Returns the thread id it wrote to.
 */
export function seedMarketingConversation(input: {
  readonly userData: string;
  readonly reviewId: string;
  /** When the conversation happened; the pane shows relative times. Defaults to 9 minutes ago. */
  readonly startedAt?: number;
}): string {
  const threadId = boundThreadId(input.userData, input.reviewId);
  const dbPath = join(input.userData, "t3", "userdata", "state.sqlite");
  if (!existsSync(dbPath)) throw new Error(`no sidecar store at ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  try {
    const versionRow = db
      .prepare(
        "SELECT COALESCE(MAX(stream_version), -1) AS version FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ?",
      )
      .get(threadId) as { version: number };
    if (versionRow.version < 0) throw new Error(`thread ${threadId} has no events in ${dbPath}`);
    const insert = db.prepare(
      `INSERT INTO orchestration_events (
         event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
         command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
       ) VALUES (?, 'thread', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    );
    let version = versionRow.version;
    let clock = input.startedAt ?? Date.now() - 9 * 60_000;
    db.exec("BEGIN");
    for (const turn of MARKETING_CONVERSATION) {
      const events = turnEvents(threadId, turn, clock);
      for (const event of events) {
        version += 1;
        insert.run(
          crypto.randomUUID(),
          threadId,
          version,
          event.type,
          event.occurredAt,
          event.commandId,
          event.causationEventId ?? null,
          event.commandId,
          event.actor,
          JSON.stringify(event.payload),
        );
      }
      // The next question comes a while after the answer.
      clock = Date.parse(events[events.length - 1]?.occurredAt ?? new Date(clock).toISOString());
      clock += 70_000;
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return threadId;
}
