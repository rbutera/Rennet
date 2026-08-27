import { useEffect, useRef } from "react";
import type { TranscriptRow } from "./chat-data";
import { Turn } from "./turn";

// ─────────────────────────────────────────────────────────────────────────────
// ConversationPane (C07, ported from the spike). The scroll region with bottom-
// anchored auto-scroll on append, mapping `chat-data.ts` transcript rows to their
// components. Turn rows land here in cluster 2; `compact-boundary` and `anchored-
// thread` rows join the switch in cluster 5 (task 2.1). `liveIds` marks the turns
// that arrived live this mount so they animate; records replay instantly.
// ─────────────────────────────────────────────────────────────────────────────

export function ConversationPane({
  rows,
  liveIds,
}: {
  readonly rows: readonly TranscriptRow[];
  readonly liveIds: ReadonlySet<string>;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `rows.length` is the intended append trigger — the pane auto-scrolls to the bottom when a row is added — not a body reference.
  useEffect(() => {
    // scrollIntoView is a no-op in some test environments; guard it.
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [rows.length]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="chat-dock-transcript">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-5 py-6">
        {rows.map((row) => {
          switch (row.kind) {
            case "turn":
              return <Turn key={row.id} turn={row} animate={liveIds.has(row.id)} />;
            default:
              // `compact-boundary` / `anchored-thread` rows render here in cluster 5.
              return null;
          }
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
