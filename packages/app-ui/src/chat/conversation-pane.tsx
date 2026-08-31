import { cn } from "@rennet/ui";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { AnchoredThread } from "./anchored-thread";
import type { ContextWindow, TranscriptRow } from "./chat-data";
import { CompactionRow, ContextRebuiltMarker } from "./compaction-row";
import { DetachedThreads } from "./detached-threads";
import { Turn } from "./turn";

// ─────────────────────────────────────────────────────────────────────────────
// ConversationPane (C07, ported from the spike). The scroll region with bottom-
// anchored auto-scroll on append, mapping `chat-data.ts` transcript rows to their
// components: turn rows (cluster 2), `compact-boundary` rows (honest compaction) and
// `anchored-thread` rows (transcript-side quote threads) added in cluster 5. `liveIds`
// marks the turns that arrived live this mount so they animate; records replay instantly.
// ─────────────────────────────────────────────────────────────────────────────

// One exhaustive mapping — a new row kind is a TypeScript error here, not a silent drop.
// MODULE-SCOPED (perf audit §5 H8): the pane re-renders on every streamed delta, so a
// renderer defined in the body minted a fresh closure per delta for nothing. What actually
// stops the work is `Turn` being `memo`'d — Wave 2's per-thread WeakMaps make a settled
// turn's row object identity-stable across deltas, so the memo's shallow compare holds and
// the transcript's settled turns stop re-rendering per streamed token. The other row kinds
// are deliberately NOT memoized: their rows are rebuilt fresh each derivation
// (`detachedThreadRowsOf` and the anchored-thread projection allocate per call), so a memo
// there would be an unprovable no-op rather than a win.
function renderRow(
  row: TranscriptRow,
  liveIds: ReadonlySet<string>,
  contextWindow: ContextWindow | undefined,
): ReactNode {
  switch (row.kind) {
    case "turn":
      return <Turn key={row.id} turn={row} animate={liveIds.has(row.id)} />;
    case "compact-boundary":
      return <CompactionRow key={row.id} row={row} contextWindow={contextWindow} />;
    case "anchored-thread":
      return <AnchoredThread key={row.threadId} row={row} />;
    case "detached-threads":
      return <DetachedThreads key={row.kind} row={row} />;
    case "context-rebuilt":
      return <ContextRebuiltMarker key={row.id} row={row} />;
  }
}

export function ConversationPane({
  rows,
  liveIds,
  contextWindow,
}: {
  readonly rows: readonly TranscriptRow[];
  readonly liveIds: ReadonlySet<string>;
  readonly contextWindow?: ContextWindow;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `rows.length` is the intended append trigger — the pane auto-scrolls to the bottom when a row is added — not a body reference.
  useEffect(() => {
    // scrollIntoView is a no-op in some test environments; guard it.
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [rows.length]);

  // A just-minted session: the reviewer's own sends and nothing back yet. The spike gives
  // that shell its own transcript region (`session-view.tsx`) — full height, BOTTOM-anchored,
  // tighter gaps — so the message you just sent sits above the composer instead of stranded
  // at the top of an empty pane. It is the same rows through the same renderer; only the
  // column changes, and it changes back the moment the orchestrator answers.
  const awaitingFirstReply = rows.every((row) => row.kind === "turn" && row.speaker === "user");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="chat-dock-transcript">
      <div
        data-transcript-state={awaitingFirstReply ? "awaiting-first-reply" : "conversation"}
        className={cn(
          "mx-auto flex w-full max-w-[720px] flex-col",
          awaitingFirstReply ? "h-full justify-end gap-3 px-5 py-4" : "gap-6 px-5 py-6",
        )}
      >
        {rows.map((row) => renderRow(row, liveIds, contextWindow))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
