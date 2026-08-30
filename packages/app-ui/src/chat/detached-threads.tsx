import { AnchoredThread } from "./anchored-thread";
import type { DetachedThreadsRow } from "./chat-data";

/** Durable quote exchanges whose exact prose no longer exists on the current board. */
export function DetachedThreads({ row }: { readonly row: DetachedThreadsRow }) {
  return (
    <section
      data-testid="detached-threads"
      className="flex flex-col gap-3 border-border border-t pt-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium text-foreground text-sm">Detached</h2>
        <span className="text-2xs text-muted-foreground">
          {row.threads.length} {row.threads.length === 1 ? "thread" : "threads"}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        These quoted passages no longer have one exact match on the current board.
      </p>
      <ul className="flex flex-col gap-3">
        {row.threads.map((thread) => (
          <li key={thread.threadId}>
            <AnchoredThread
              row={{
                kind: "anchored-thread",
                threadId: thread.threadId,
                boardRef: thread.boardRef,
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
